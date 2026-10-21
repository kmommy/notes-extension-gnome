// notes@maestroschan.fr/extension.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as NoteBox from './noteBox.js';
import * as Ticker from './ticker.js';
import {State} from './state.js';

//------------------------------------------------------------------------------

const PATH = GLib.build_pathv('/', [GLib.get_user_data_dir(), 'notes@maestroschan.fr']);
// which is usually ~/.local/share/notes@maestroschan.fr

let SETTINGS;
let LAYER_SETTING = '';

export default class NotesExtension extends Extension {
	enable() {
		try {
			let a = Gio.file_new_for_path(PATH);
			if (!a.query_exists(null)) {
				a.make_directory(null);
			}
		} catch (e) {
			console.log(e.message);
		}

		State.extension = this;
		SETTINGS = State.settings = this.getSettings();

		State.notesManager = new NotesManager();
	}

	disable() {
		State.notesManager?.destroy();
		State.notesManager = null;

		SETTINGS = State.settings = null;
		State.extension = null;
	}
}

//------------------------------------------------------------------------------

/*
 * A singleton that manages the button in the top bar, and thus provides the
 * actions of loading, showing, hiding, creating (and in some way saving and
 * destroying) all the notes.
 * A left click on the button shows or hides the notes, and a right click opens
 * a menu to create a note, or show again the notes hidden individually.
 * If no note exists, it will create the first one itself, otherwise it serves
 * as a middleman between the note whose "new" button has been pressed and the
 * new one.
 */
class NotesManager {
	constructor() {
		// Initialisation of the button in the top panel
		this.panel_button = new PanelMenu.Button(0.0, _("Show notes"), true);
		this._icon = new St.Icon({
			icon_name: 'document-edit-symbolic',
			style_class: 'system-status-icon'
		});
		// The text of the pinned notes scrolls next to the icon
		this._ticker = new Ticker.PanelTicker();
		let buttonBox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
		buttonBox.add_child(this._icon);
		buttonBox.add_child(this._ticker.actor);
		this.panel_button.add_child(buttonBox);
		if (Clutter.ClickGesture) {
			// In recent versions of GNOME, the button-press-event signal is
			// not emitted anymore for actors using gestures, such as the
			// panel buttons
			let clickGesture = new Clutter.ClickGesture();
			clickGesture.set_recognize_on_press(true);
			clickGesture.connect('recognize', () => {
				this._onPanelButtonClicked(clickGesture.get_button());
			});
			this.panel_button.add_action(clickGesture);
		} else {
			this.panel_button.connect('button-press-event', (actor, event) => {
				this._onPanelButtonClicked(event.get_button());
			});
		}

		// The menu isn't given to the panel button with setMenu(), otherwise
		// the button would open it on every click
		this._menu = new PopupMenu.PopupMenu(this.panel_button, 0.5, St.Side.TOP);
		this._menu.actor.add_style_class_name('panel-menu');
		Main.uiGroup.add_child(this._menu.actor);
		this._menu.actor.hide();
		this._menuManager = new PopupMenu.PopupMenuManager(this.panel_button);
		this._menuManager.addMenu(this._menu);
		this._hiddenNoteNotified = false;

		this._overviewNotes = new Ticker.OverviewNotes(this._onOverviewCardClicked.bind(this));

		this._updateIconVisibility();
		// `0` is the position within the chosen box (here, the `right` one)
		Main.panel.addToStatusArea('NotesButton', this.panel_button, 0, 'right');

		// Initialisation of the notes themselves
		this._allNotes = new Array();
		this._notesAreVisible = false;
		this._updateLayerSetting(); // it inits LAYER_SETTING

		this._notesLoaded = false; // this will tell the toggleState method that
		// notes need to be loaded first, thus doing the actual initialisation

		// Initialisation of the signals connections
		this._bindKeyboardShortcut();
		this._connectAllSignals();

		// Notifications allowing to cancel the deletion of a note
		this._undoNotifications = new Set();

		// If the notes were visible at the end of the previous session (or
		// before the screen was locked), they're shown again. The notes are
		// also loaded if the pinned ones have to be displayed.
		if (SETTINGS.get_boolean('notes-visible') || this._pinnedNotesAreDisplayed()) {
			if (Main.layoutManager._startingUp) {
				this._startupId = Main.layoutManager.connect('startup-complete', () => {
					Main.layoutManager.disconnect(this._startupId);
					this._startupId = null;
					this._restoreVisibleNotes();
				});
			} else {
				this._restoreIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
					this._restoreIdleId = null;
					this._restoreVisibleNotes();
					return GLib.SOURCE_REMOVE;
				});
			}
		}
	}

	_restoreVisibleNotes () {
		if (!this._notesLoaded) {
			this._loadAllNotes();
		}
		if (this._allNotes.length > 0 && SETTINGS.get_boolean('notes-visible')) {
			this._showNotes();
		}
	}

	_bindKeyboardShortcut () {
		this._useKeyboardShortcut = SETTINGS.get_boolean('use-shortcut');
		if (this._useKeyboardShortcut) {
			Main.wm.addKeybinding(
				'notes-kb-shortcut',
				SETTINGS,
				Meta.KeyBindingFlags.NONE,
				Shell.ActionMode.ALL,
				this._onButtonPressed.bind(this)
			);
		}
	}

	_loadAllNotes () {
		let i = 0;
		let ended = false;
		while(!ended) {
			let file2 = GLib.build_filenamev([PATH, i.toString() + '_state']);
			if (GLib.file_test(file2, GLib.FileTest.EXISTS)) {
				this.createNote('', 16);
			} else {
				ended = true;
			}
			i++;
		}
		this._onlyHideNotes();
		this._notesLoaded = true;
		this.updatePinnedNotes();
	}

	//--------------------------------------------------------------------------
	// "Public" methods, accessed by the NoteBox objects -----------------------

	createNote (colorString, fontSize) {
		let nextId = this._allNotes.length;
		try {
			this._allNotes.push(new NoteBox.NoteBox(nextId, colorString, fontSize));
		} catch (e) {
			Main.notify(_("Notes extension error: failed to load a note"));
			console.error('failed to create note n°' + nextId.toString());
			console.error(e);
		}
	}

	/*
	 * When a NoteBox object deletes itself, it calls this method to ensure the
	 * files go from 0 to (this._allNotes.length - 1) without any "gap" in the
	 * numerotation.
	 */
	postDelete (deletedNoteId) {
		let lastNote = this._allNotes.pop();
		if (deletedNoteId < this._allNotes.length) {
			this._allNotes[deletedNoteId] = lastNote;
			lastNote.id = deletedNoteId;
			this._allNotes[deletedNoteId].onlySave();
		}
		this._deleteNoteFiles(this._allNotes.length);
		this.updatePinnedNotes();
	}

	/*
	 * Updates the scrolling text in the top bar and the cards in the overview,
	 * which show the pinned notes. Called by the NoteBox objects when a pinned
	 * note changes.
	 */
	updatePinnedNotes () {
		let pinned = this._allNotes.filter((n) => n.pinned && !n.isEmpty());
		this._ticker.setNotes(SETTINGS.get_boolean('pinned-in-panel') ? pinned : []);
		this._overviewNotes.setNotes(SETTINGS.get_boolean('pinned-in-overview') ? pinned : []);
		this._updateIconVisibility();
	}

	/*
	 * Tells if [x, y] are suitable coords for a note (= not too close of the
	 * other existing notes). Called by NoteBox objects on various occasions,
	 * for example when brought back to the primary monitor, or when deciding
	 * the initial coords at the creation of the note.
	 */
	areCoordsUsable (x, y) {
		let areaIsFree = true;
		this._allNotes.forEach(function (n) {
			if( (Math.abs(n._x - x) < 230) && (Math.abs(n._y - y) < 100) ) {
				areaIsFree = false;
			}
		});
		return areaIsFree;
	}

	notesNeedChromeTracking () {
		return this._layerId == 'above-all';
	}

	/*
	 * Called when a non-empty note has been deleted, with the content of its
	 * files, to propose to cancel the deletion.
	 */
	onNoteDeleted (text, state) {
		let source = MessageTray.getSystemSource();
		let notification = new MessageTray.Notification({
			source,
			title: _("Note deleted"),
			body: text.split('\n').find((line) => line.trim() !== '') ?? '',
			isTransient: true,
		});
		notification.addAction(_("Undo"), () => {
			this._restoreNote(text, state);
		});
		notification.connect('destroy', () => {
			this._undoNotifications.delete(notification);
		});
		this._undoNotifications.add(notification);
		source.addNotification(notification);
	}

	/*
	 * The files of the deleted note are written again with the next id, and
	 * the note is created from them.
	 */
	_restoreNote (text, state) {
		let id = this._allNotes.length.toString();
		GLib.file_set_contents(GLib.build_filenamev([PATH, id + '_state']), state);
		GLib.file_set_contents(GLib.build_filenamev([PATH, id + '_text']), text);
		this.createNote('', 16);
		this._showNotes();
		this.updatePinnedNotes();
	}

	/*
	 * Called when a note is hidden with its own 'hide' button. The first time,
	 * the user is told how to find the note again.
	 */
	onNoteHidden () {
		if (this._hiddenNoteNotified) {
			return;
		}
		this._hiddenNoteNotified = true;
		Main.notify(
			_("Note hidden"),
			_("Right-click the notes icon in the top bar to show it again.")
		);
	}

	//--------------------------------------------------------------------------

	_showNotes () {
		this._menu.close();
		this._notesAreVisible = true;
		SETTINGS.set_boolean('notes-visible', true);
		this._allNotes.forEach(function (n) {
			n.show();
		});
	}

	_hideNotes () {
		this._onlyHideNotes();
		SETTINGS.set_boolean('notes-visible', false);
		if (this._timeout_id) {
			GLib.source_remove(this._timeout_id);
		}
		this._timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
			this._timeout_id = null;
			// saving to the disk is slightly delayed to give the illusion that
			// the extension doesn't freeze the system
			this._allNotes.forEach(function (n) {
				n.onlySave(false);
			});
			return GLib.SOURCE_REMOVE;
		});
	}

	_onlyHideNotes () {
		this._allNotes.forEach(function (n) {
			n.onlyHide();
		});
		this._notesAreVisible = false;
	}

	_deleteNoteFiles (id) {
		let filePathBeginning = PATH + '/' + id.toString();
		let textfile = Gio.file_new_for_path(filePathBeginning + '_text');
		let statefile = Gio.file_new_for_path(filePathBeginning + '_state');
		[textfile, statefile].forEach((file) => {
			try {
				file.delete(null);
			} catch (e) {
				// the file may not exist
				if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
					throw e;
			}
		});
	}

	_pinnedNotesAreDisplayed () {
		return SETTINGS.get_boolean('pinned-in-panel')
		    || SETTINGS.get_boolean('pinned-in-overview');
	}

	_onPinnedSettingChanged () {
		if (!this._notesLoaded) {
			if (this._pinnedNotesAreDisplayed()) {
				this._loadAllNotes();
			}
		} else {
			this.updatePinnedNotes();
		}
	}

	_onOverviewCardClicked (note) {
		Main.overview.hide();
		note.reveal();
		this._showNotes();
		note.raise();
	}

	_onPanelButtonClicked (mouseButton) {
		if (mouseButton === Clutter.BUTTON_SECONDARY) {
			this._openMenu();
		} else {
			this._onButtonPressed();
		}
	}

	_openMenu () {
		if(!this._notesLoaded) {
			this._loadAllNotes();
		}
		this._menu.removeAll();

		this._menu.addAction(_("New note"), () => {
			this.createNote('', 16);
			this._showNotes();
		}, 'list-add-symbolic');

		let searchEntry = null;
		if (this._allNotes.length > 0) {
			let searchItem = new PopupMenu.PopupBaseMenuItem({
				reactive: false,
				can_focus: false,
			});
			searchEntry = new St.Entry({
				hint_text: _("Search notes…"),
				can_focus: true,
				x_expand: true,
				style_class: 'search-entry',
			});
			searchItem.add_child(searchEntry);
			this._menu.addMenuItem(searchItem);

			let notesSection = new PopupMenu.PopupMenuSection();
			this._menu.addMenuItem(notesSection);
			this._fillNotesSection(notesSection, '');

			searchEntry.clutter_text.connect('text-changed', () => {
				this._fillNotesSection(notesSection, searchEntry.get_text());
			});
			searchEntry.clutter_text.connect('activate', () => {
				// Enter opens the first result
				notesSection._getMenuItems().find((item) => item.reactive)?.activate(
					Clutter.get_current_event()
				);
			});
		}

		this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
		this._menu.addAction(_("Settings"), () => {
			State.extension.openPreferences();
		}, 'preferences-system-symbolic');

		this._menu.open();
		searchEntry?.grab_key_focus();
	}

	/*
	 * Without query, the section lists the notes hidden individually, so they
	 * can be shown again. With a query, it lists all the notes whose title or
	 * text contains it.
	 */
	_fillNotesSection (section, query) {
		section.removeAll();
		query = query.trim().toLowerCase();

		let notes;
		if (query === '') {
			notes = this._allNotes.filter((n) => n.hidden);
			if (notes.length > 0) {
				section.addMenuItem(
					new PopupMenu.PopupSeparatorMenuItem(_("Hidden notes"))
				);
			}
		} else {
			notes = this._allNotes.filter((n) => n.matches(query));
			if (notes.length === 0) {
				section.addMenuItem(new PopupMenu.PopupMenuItem(
					_("No matching note"),
					{ reactive: false }
				));
			}
		}

		notes.forEach((n) => {
			let icon = n.hidden ? 'view-reveal-symbolic' : 'document-edit-symbolic';
			section.addAction(n.getTitle(), () => {
				n.reveal();
				this._showNotes();
				n.raise();
			}, icon);
		});
	}

	_onButtonPressed () {
		if(!this._notesLoaded) {
			this._loadAllNotes();
		}
		// log('_onButtonPressed');

		let preventReshowing = false;
		if(LAYER_SETTING === 'cycle-layers') {
			this._allNotes.forEach(function (n) {
				n.removeFromCorrectLayer();
			});

			// the notes' visibility will be inverted later
			if(!this._notesAreVisible) {
				this._layerId = 'on-background';
				this._notesAreVisible = false;
			} else if(this._layerId === 'on-background') {
				this._layerId = 'above-all';
				this._notesAreVisible = false;
				preventReshowing = true;
			} else if(this._layerId === 'above-all') {
				this._layerId = 'above-all';
				this._notesAreVisible = true;
			}

			this._allNotes.forEach(function (n) {
				n.loadIntoCorrectLayer();
			});
		}

		if(this._allNotes.length == 0) {
			this.createNote('', 16);
			this._showNotes();
		} else if (this._notesAreVisible) {
			this._hideNotes();
		} else if (preventReshowing) {
			this._notesAreVisible = true;
		} else if (this._allNotes.every((n) => n.hidden)) {
			// showing the notes would do nothing, so the user has to choose
			this._openMenu();
		} else {
			this._showNotes();
		}
	}

	//--------------------------------------------------------------------------
	// Watch the gsettings values and update the extension if they change ------

	_connectAllSignals () {
		this._settingsSignals = {};

		this._settingsSignals['layout'] = SETTINGS.connect(
			'changed::layout-position',
			this._updateLayerSetting.bind(this)
		);
		this._settingsSignals['bring-back'] = SETTINGS.connect(
			'changed::ugly-hack',
			this._bringToPrimaryMonitorOnly.bind(this)
		);
		this._settingsSignals['hide-icon'] = SETTINGS.connect(
			'changed::hide-icon',
			this._updateIconVisibility.bind(this)
		);
		this._settingsSignals['kb-shortcut-1'] = SETTINGS.connect(
			'changed::use-shortcut',
			this._updateShortcut.bind(this)
		);
		this._settingsSignals['kb-shortcut-2'] = SETTINGS.connect(
			'changed::notes-kb-shortcut',
			this._updateShortcut.bind(this)
		);
		this._settingsSignals['pinned-panel'] = SETTINGS.connect(
			'changed::pinned-in-panel',
			this._onPinnedSettingChanged.bind(this)
		);
		this._settingsSignals['pinned-overview'] = SETTINGS.connect(
			'changed::pinned-in-overview',
			this._onPinnedSettingChanged.bind(this)
		);

		this._monitorsChangedId = Main.layoutManager.connect(
			'monitors-changed',
			this._onMonitorsChanged.bind(this)
		);
	}

	_onMonitorsChanged () {
		this._allNotes.forEach(function (n) {
			n.updatePosition();
		});
		this._overviewNotes.updatePosition();
	}

	_updateShortcut () {
		if(this._useKeyboardShortcut) {
			Main.wm.removeKeybinding('notes-kb-shortcut');
		}
		this._bindKeyboardShortcut();
	}

	/*
	 * If the icon is hidden, the button stays visible as long as it shows the
	 * text of pinned notes.
	 */
	_updateIconVisibility () {
		this._icon.visible = !SETTINGS.get_boolean('hide-icon');
		this.panel_button.visible = this._icon.visible || this._ticker.actor.visible;
	}

	_bringToPrimaryMonitorOnly () {
		this._allNotes.forEach(function (n) {
			n.fixState();
		});
	}

	/*
	 * Remove all the notes from where they are, and add them to the layer that
	 * is actually set by the user. Possible values for the layers can be
	 * 'above-all', 'on-background' or 'cycle-layers'.
	 */
	_updateLayerSetting () {
		this._allNotes.forEach(function (n) {
			n.removeFromCorrectLayer();
		});

		LAYER_SETTING = SETTINGS.get_string('layout-position');
		this._layerId = (LAYER_SETTING == 'on-background')
			? 'on-background'
			: 'above-all'
		;

		this._allNotes.forEach(function (n) {
			n.loadIntoCorrectLayer();
		});

		if(!this._notesAreVisible) {
			this._onlyHideNotes();
		}
	}

	//--------------------------------------------------------------------------

	destroy() {
		SETTINGS.disconnect(this._settingsSignals['layout']);
		SETTINGS.disconnect(this._settingsSignals['bring-back']);
		SETTINGS.disconnect(this._settingsSignals['hide-icon']);
		SETTINGS.disconnect(this._settingsSignals['kb-shortcut-1']);
		SETTINGS.disconnect(this._settingsSignals['kb-shortcut-2']);
		SETTINGS.disconnect(this._settingsSignals['pinned-panel']);
		SETTINGS.disconnect(this._settingsSignals['pinned-overview']);
		Main.layoutManager.disconnect(this._monitorsChangedId);
		if (this._startupId) {
			Main.layoutManager.disconnect(this._startupId);
		}
		if (this._restoreIdleId) {
			GLib.source_remove(this._restoreIdleId);
		}
		this._undoNotifications.forEach((n) => n.destroy());

		this._allNotes.forEach(function (n) {
			n.onlySave(false);
			n.destroy();
		});

		if(this._useKeyboardShortcut) {
			Main.wm.removeKeybinding('notes-kb-shortcut');
		}

		this._menu.destroy();
		this._ticker.destroy();
		this._overviewNotes.destroy();
		this.panel_button.destroy();

		if (this._timeout_id) {
			GLib.source_remove(this._timeout_id);
			this._timeout_id = null;
		}
	}
}

//------------------------------------------------------------------------------

