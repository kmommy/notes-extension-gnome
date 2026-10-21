// notes@maestroschan.fr/noteBox.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Menus from './menus.js';
import * as Dialog from './dialog.js';
import {State} from './state.js';

// ~/.local/share/notes@maestroschan.fr
const PATH = GLib.build_pathv('/', [GLib.get_user_data_dir(), 'notes@maestroschan.fr']);

const MIN_HEIGHT = 75;
const MIN_WIDTH = 200;

// Delay (in milliseconds) between the last keystroke and the saving of the text
const SAVE_DELAY = 1000;

// Tasks are lines starting with one of these characters, followed by a space.
// They're stored as plain text, so the notes files stay readable.
const TASK_TODO = '☐';
const TASK_DONE = '☑';

//------------------------------------------------------------------------------

function stringFromArray(data){
	if (data instanceof Uint8Array) {
		return new TextDecoder().decode(data);
	} else {
		return data.toString();
	}
}

function isTaskBox(char) {
	return char === TASK_TODO || char === TASK_DONE;
}

/*
 * ClutterText positions are counted in characters, not in UTF-16 code units,
 * so the text is handled as an array of characters.
 */
function getLineStart(chars, pos) {
	while (pos > 0 && chars[pos - 1] !== '\n') {
		pos--;
	}
	return pos;
}

function getLineEnd(chars, pos) {
	let end = chars.indexOf('\n', pos);
	return end === -1 ? chars.length : end;
}

function getCursorPosition(clutterText, chars) {
	let pos = clutterText.get_cursor_position();
	return pos < 0 ? chars.length : pos;
}

/*
 * Returns [number of checked tasks, total number of tasks] in the text.
 */
function countTasks(text) {
	let done = 0;
	let total = 0;
	text.split('\n').forEach((line) => {
		if (isTaskBox(line[0])) {
			total++;
			if (line[0] === TASK_DONE) {
				done++;
			}
		}
	});
	return [done, total];
}

/*
 * This class stands for one note. The note's id corresponds to the name of
 * files where its data will be stored. The note's state is loaded and the note
 * is built, then the note's text is loaded.
 * Almost all of the init process is done in the _buildNote() method. Then, the
 * other methods are here for managing note state through buttons, or to
 * interact with the NotesManager singleton.
 */
export class NoteBox {
	constructor (id, color, fontSize) {
		this.id = id;
		this._fontSize = fontSize;
		this.hidden = false;
		if (color.split(',').length == 3) {
			this.customColor = color;
		} else {
			let c = State.settings.get_strv('first-note-rgb');
			c[0] = Math.round(c[0] * 255);
			c[1] = Math.round(c[1] * 255);
			c[2] = Math.round(c[2] * 255);
			this.customColor = c.toString();
		}
		this._buildNote();
	}

	_buildNote () {
		this.actor = new St.BoxLayout({
			reactive: true,
			orientation: Clutter.Orientation.VERTICAL,
			min_height: MIN_HEIGHT,
			min_width: MIN_WIDTH,
			style_class: 'noteBoxStyle',
			track_hover: true,
		});

		this._fontColor = '';
		this._loadState();
		this._applyActorStyle();

		// This actually builds all the possible headerbars
		this._buildHeaderbar();

		//----------------------------------------------------------------------

		this._scrollView = new St.ScrollView({
			overlay_scrollbars: true,
			// if true, the scrollbar is inside the textfield, else it's outside
			x_expand: true,
			y_expand: true,
			clip_to_allocation: true,
		});

		this.noteEntry = new St.Entry({
			name: 'noteEntry',
			can_focus: true,
			hint_text: _("Type here…"),
			track_hover: true,
			x_expand: true,
			style_class: 'notesTextField',
		});
		let clutterText = this.noteEntry.get_clutter_text();
		clutterText.set_single_line_mode(false);
		clutterText.set_activatable(false); // we can press Enter
		clutterText.set_line_wrap(true);
		clutterText.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);

		this._entryBox = new St.BoxLayout({
			reactive: true,
			x_expand: true,
			y_expand: true,
			visible: this.entry_is_visible,
		});

		this._entryBox.add_child(this.noteEntry);
		this._scrollView.set_child(this._entryBox);
		this.actor.add_child(this._scrollView);

		this._buildFooter();

		//----------------------------------------------------------------------

		this._grabHelper = new GrabHelper.GrabHelper(this.noteEntry)
		// The 'auto-focus' setting is read on each event, so changing it
		// doesn't require to reload the extension
		this.noteEntry.connect('enter-event', this._onEntryEnter.bind(this));
		this.noteEntry.connect('button-press-event', this._getKeyFocus.bind(this));
		this.noteEntry.connect('leave-event', this._leaveKeyFocus.bind(this));
		this.actor.connect('notify::hover', this._onHoverChanged.bind(this));
		// Captured before the text gets it, so a click on a box doesn't move
		// the cursor, and Enter in a task can be replaced by a new task
		this.noteEntry.connect('captured-event', this._onEntryCapturedEvent.bind(this));

		//----------------------------------------------------------------------

		// Each note sets its own actor where it should be. This isn't a problem
		// since the related setting isn't directly accessed, but is stored in
		// 'State.notesManager' instead, which prevents inconsistencies.
		this.loadIntoCorrectLayer();
		this._setNotePosition();
		this._loadText();
		// ShellEntry.addContextMenu(this.noteEntry); // FIXME doesn't work
		this._initStyle();
		this._onHoverChanged();

		// Connected after the text is loaded, so loading doesn't trigger a save
		clutterText.connect('text-changed', this._onTextChanged.bind(this));

		this.grabX = this._x + 100;
		this.grabY = this._y + 10;
	}

	/*
	 * The headerbar contains the UI controls to manage the note:
	 * - The 'new note' button creates a note with the same color and font size,
	 *   but with random coordinates, an empty text, and an harcoded size.
	 * - The 'move' area, which isn't styled as a button but looks like an empty
	 *   space. It simulates a kind of wacky window dragging.
	 * - The 'task' button, which turns the current line into a task (a line
	 *   with a checkbox), or back into regular text.
	 * - The 'options' button, showing a menu defined in menus.js
	 * - The 'hide' button, which hides this note only. It can be shown again
	 *   from the menu of the icon in the top bar.
	 * - The 'delete' button deletes the note. If the note isn't empty, it asks
	 *   the user to confirm (see `dialog.js`). Then the object is destroyed,
	 *   and a method from the NotesManager is called to correctly delete the
	 *   corresponding files.
	 * The buttons are only visible when the note is hovered.
	 */
	_buildHeaderbar () {
		// This is the regular header, as described above.
		this._buttonsBox = new St.BoxLayout({
			orientation: Clutter.Orientation.HORIZONTAL,
			visible: true,
			reactive: true,
			x_expand: true,
			y_expand: false,
			style_class: 'noteHeaderStyle',
		});

		let btnNew = new Menus.NoteRoundButton(
			this,
			'list-add-symbolic',
			_("New")
		);
		btnNew.actor.connect('clicked', this._createNote.bind(this));
		this._buttonsBox.add_child(btnNew.actor);

		// Not an St.Button, its click gesture would consume the press events
		this.moveBox = new St.BoxLayout({
			x_expand: true,
			reactive: true,
			track_hover: true,
			style_class: 'notesTitleButton',
		});
		this._titleLabel = new St.Label({
			text: this._title,
			x_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
			style_class: 'notesTitleLabel',
		});
		this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
		this.moveBox.add_child(this._titleLabel);
		this._buttonsBox.add_child(this.moveBox);

		let btnTask = new Menus.NoteRoundButton(
			this,
			'checkbox-checked-symbolic',
			_("Task")
		);
		btnTask.actor.connect('clicked', this._toggleTaskOnCurrentLine.bind(this));
		this._buttonsBox.add_child(btnTask.actor);

		this._btnOptions = new Menus.NoteRoundButton(
			this,
			'view-more-symbolic',
			_("Note options")
		);
		this._btnOptions.addMenu();
		this._btnOptions.connect('menu-state-changed', this._onHoverChanged.bind(this));
		this._buttonsBox.add_child(this._btnOptions.actor);

		let btnHide = new Menus.NoteRoundButton(
			this,
			'view-conceal-symbolic',
			_("Hide")
		);
		btnHide.actor.connect('clicked', this._onHide.bind(this));
		this._buttonsBox.add_child(btnHide.actor);

		let btnDelete = new Menus.NoteRoundButton(
			this,
			'user-trash-symbolic',
			_("Delete")
		);
		btnDelete.actor.connect('clicked', this._onDelete.bind(this));
		this._buttonsBox.add_child(btnDelete.actor);

		this._headerButtons = [
			btnNew.actor,
			btnTask.actor,
			this._btnOptions.actor,
			btnHide.actor,
			btnDelete.actor,
		];

		this.moveBox.connect('button-press-event', this._onMovePress.bind(this));
		this.moveBox.connect('motion-event', this._onMoveMotion.bind(this));
		this.moveBox.connect('button-release-event', this._onRelease.bind(this));

		this.actor.add_child(this._buttonsBox);
	}

	/*
	 * The footer only contains a grip in the lower-right corner, which uses the
	 * same dragging mecanism as 'move', to resize the note.
	 */
	_buildFooter () {
		this._footer = new St.BoxLayout({
			x_expand: true,
			visible: this.entry_is_visible,
		});
		this._footer.add_child(new St.Widget({ x_expand: true }));

		this._resizeGrip = new St.Widget({
			reactive: true,
			track_hover: true,
			accessible_name: _("Resize"),
			style_class: 'noteResizeGrip',
		});
		this._footer.add_child(this._resizeGrip);

		this._resizeGrip.connect('button-press-event', this._onResizePress.bind(this));
		this._resizeGrip.connect('motion-event', this._onResizeMotion.bind(this));
		this._resizeGrip.connect('button-release-event', this._onRelease.bind(this));

		this.actor.add_child(this._footer);
	}

	_onHoverChanged () {
		if (this.actor == null) { return; }
		this._applyActorStyle();
		let showControls = this.actor.hover || this._btnOptions.isMenuOpen();
		this._headerButtons.forEach((btn) => {
			btn.opacity = showControls ? 255 : 0;
		});
		this._resizeGrip.opacity = showControls ? 255 : 0;
	}

	_onDelete () {
		if (this.noteEntry.get_text() === '') {
			this._deleteNoteObject();
		} else {
			this._openDeleteDialog();
		}
	}

	_openDeleteDialog () {
		let noteText = this.noteEntry.get_text();
		// The text has to be truncated to avoid issues with long notes
		let lines = noteText.split("\n")
		if(lines.length > 10) {
			noteText = lines[0] + "\n" + lines[1] + "\n" + lines[2] + "\n[...]\n";
			noteText += lines[lines.length - 2] + "\n" + lines[lines.length - 1];
		}

		let dialog = new Dialog.CustomModalDialog(
			_("Delete this note?"),
			noteText,
			_("Delete"),
			this._deleteNoteObject.bind(this)
		);
		dialog.open();
	}

	_initStyle () {
		let initialRGB_r = this.customColor.split(',')[0];
		let initialRGB_g = this.customColor.split(',')[1];
		let initialRGB_b = this.customColor.split(',')[2];
		this._applyColor(initialRGB_r, initialRGB_g, initialRGB_b);
		this._applyActorStyle();
		this._applyNoteStyle();
	}

	//--------------------------------------------------------------------------
	// "Public" methods called by NotesManager ---------------------------------

	loadIntoCorrectLayer () {
		if (State.notesManager.notesNeedChromeTracking()) {
			Main.layoutManager.addChrome(this.actor);
			this._isTracked = true;
		} else {
			Main.layoutManager._backgroundGroup.add_child(this.actor);
		}
	}

	removeFromCorrectLayer () {
		if (State.notesManager.notesNeedChromeTracking()) {
			Main.layoutManager.removeChrome(this.actor);
			this._isTracked = false;
		} else {
			Main.layoutManager._backgroundGroup.remove_child(this.actor);
		}
	}

	show () {
		if (this.hidden) { return; }
		this.actor.visible = true;
		if (State.notesManager.notesNeedChromeTracking() && !this._isTracked) {
			Main.layoutManager.trackChrome(this.actor);
			this._isTracked = true;
		}
	}

	onlyHide () {
		this.actor.visible = false;
		if (this._isTracked) {
			Main.layoutManager.untrackChrome(this.actor);
			this._isTracked = false;
		}
	}

	onlySave (withMetadata=true) {
		if(withMetadata) {
			this._saveState();
		}
		this._saveText();
	}

	/*
	 * Makes a note hidden with the 'hide' button visible again. It will be
	 * actually shown the next time the NotesManager shows the notes.
	 */
	reveal () {
		this.hidden = false;
		this._saveState();
	}

	/*
	 * Returns the title of the note, or its first non-empty line, followed by
	 * the progress of its tasks, to identify it in menus.
	 */
	getTitle () {
		let title = this._title || this._getFirstLine();
		let [done, total] = countTasks(this.noteEntry.get_text());
		if (total > 0) {
			title += ' (' + done + '/' + total + ')';
		}
		return title;
	}

	/*
	 * Tells if the title or the text of the note contains the query, which is
	 * expected to be lowercase.
	 */
	matches (query) {
		return this._title.toLowerCase().includes(query)
		    || this.noteEntry.get_text().toLowerCase().includes(query);
	}

	openEditTitleDialog () {
		let dialog = new Dialog.CustomModalDialog(
			_("Note title"),
			_("Leave empty to show no title."),
			_("Apply"),
			this.setTitle.bind(this),
			this._title
		);
		dialog.open();
	}

	setTitle (title) {
		this._title = title.trim();
		this._titleLabel.text = this._title;
		this._saveState();
		if (this.pinned) {
			State.notesManager.updatePinnedNotes();
		}
	}

	/*
	 * A pinned note is shown in the top bar and in the overview, depending on
	 * the settings.
	 */
	setPinned (pinned) {
		this.pinned = pinned;
		this._saveState();
		State.notesManager.updatePinnedNotes();
	}

	isEmpty () {
		return this.noteEntry.get_text().trim() === '';
	}

	/*
	 * Returns the non-empty lines of the note, without the spaces around them.
	 */
	getTextLines () {
		return this.noteEntry.get_text().split('\n')
			.map((line) => line.trim())
			.filter((line) => line !== '');
	}

	getPinnedTitle () {
		return this._title;
	}

	/*
	 * Returns the whole note on one line, for the scrolling text in the top bar.
	 */
	getInlineText () {
		let text = this.getTextLines().join('  ·  ');
		if (this._title !== '') {
			text = this._title + ' — ' + text;
		}
		return text;
	}

	/*
	 * Returns the background color ('r,g,b') and the text color (CSS).
	 */
	getColors () {
		return [this.customColor, this._fontColor];
	}

	_getFirstLine () {
		let firstLine = this.noteEntry.get_text().split("\n").find((line) => {
			return line.trim() !== '';
		});
		if (firstLine === undefined) {
			return _("Empty note");
		}
		firstLine = firstLine.trim();
		if (isTaskBox(firstLine[0])) {
			firstLine = firstLine.substring(1).trim();
		}
		if (firstLine.length > 40) {
			firstLine = firstLine.substring(0, 40) + '…';
		}
		return firstLine;
	}

	fixState () {
		this._monitor = Main.layoutManager.primaryIndex;
		let outX = (this._x < 0 || this._x > Main.layoutManager.primaryMonitor.width - 20);
		let outY = (this._y < 0 || this._y > Main.layoutManager.primaryMonitor.height - 20);
		if (outX || outY || Number.isNaN(this._x) || Number.isNaN(this._y)) {
			[this._x, this._y] = this._computeRandomPosition();
			this._setNotePosition();
		}
		if (Number.isNaN(this._x)) { this._x = 10; }
		if (Number.isNaN(this._y)) { this._y = 10; }
		if (Number.isNaN(this.actor.width)) { this.actor.width = 250; }
		if (Number.isNaN(this.actor.height)) { this.actor.height = 200; }
		if (Number.isNaN(this._fontSize)) { this._fontSize = 10; }
		this._saveState();
	}

	//--------------------------------------------------------------------------

	_onHide () {
		this.hidden = true;
		this.onlyHide();
		this.onlySave();
		State.notesManager.onNoteHidden();
	}

	_applyActorStyle () {
		if (this.actor == null) { return; }
		let temp = 'background-color: rgb(' + this.customColor + ');';
		if(this._fontColor != '') {
			temp += 'color: ' + this._fontColor + ';';
		}
		this.actor.style = temp;
	}

	_applyNoteStyle () {
		let temp = '';
		if(this._fontColor != '') {
			temp += 'color: ' + this._fontColor + ';';
		}
		if(this._fontSize != 0) {
			temp += 'font-size: ' + this._fontSize + 'px;';
		}
		this.noteEntry.style = temp;
	}

	_getKeyFocus () {
		if (this.entry_is_visible) {
			this._grabHelper.grab({ actor: this.noteEntry });
			this.noteEntry.grab_key_focus();
		}
		this.raise();
	}

	_onEntryEnter () {
		if (State.settings.get_boolean('auto-focus')) {
			this._getKeyFocus();
		}
	}

	_leaveKeyFocus () {
		this._grabHelper.ungrab({ actor: this.noteEntry });
	}

	/*
	 * Puts the note above the other notes. Nothing is saved here: the
	 * actions which change the note save it themselves.
	 */
	raise () {
		this.actor.get_parent().set_child_above_sibling(this.actor, null);
	}

	_onTextChanged () {
		if (this._saveTimeoutId) {
			GLib.source_remove(this._saveTimeoutId);
		}
		this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
			this._saveTimeoutId = null;
			this._saveText();
			if (this.pinned) {
				State.notesManager.updatePinnedNotes();
			}
			return GLib.SOURCE_REMOVE;
		});
	}

	//--------------------------------------------------------------------------
	// Tasks (lines starting with a checkbox) ----------------------------------

	_onEntryCapturedEvent (actor, event) {
		switch (event.type()) {
			case Clutter.EventType.BUTTON_PRESS:
				return this._onTaskBoxPress(event);
			case Clutter.EventType.KEY_PRESS:
				return this._onEntryKeyPress(event);
			default:
				return Clutter.EVENT_PROPAGATE;
		}
	}

	/*
	 * Keyboard shortcuts available while typing in the note:
	 * - Ctrl+T turns the current line into a task, or back into text;
	 * - Ctrl+Plus and Ctrl+Minus change the font size;
	 * - Escape gives the keyboard focus back.
	 */
	_onEntryKeyPress (event) {
		let key = event.get_key_symbol();
		if (key === Clutter.KEY_Escape) {
			this._leaveKeyFocus();
			global.stage.set_key_focus(null);
			return Clutter.EVENT_STOP;
		}
		if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
			switch (key) {
				case Clutter.KEY_t:
				case Clutter.KEY_T:
					this._toggleTaskOnCurrentLine();
					return Clutter.EVENT_STOP;
				case Clutter.KEY_plus:
				case Clutter.KEY_equal:
				case Clutter.KEY_KP_Add:
					this.changeFontSize(1);
					return Clutter.EVENT_STOP;
				case Clutter.KEY_minus:
				case Clutter.KEY_KP_Subtract:
					this.changeFontSize(-1);
					return Clutter.EVENT_STOP;
				default:
					break;
			}
		}
		return this._onTaskEnterPress(event);
	}

	/*
	 * A click on the box of a task checks or unchecks it.
	 */
	_onTaskBoxPress (event) {
		if (event.get_button() !== 1) { return Clutter.EVENT_PROPAGATE; }
		let clutterText = this.noteEntry.get_clutter_text();
		let [stageX, stageY] = event.get_coords();
		let [ok, x, y] = clutterText.transform_stage_point(stageX, stageY);
		if (!ok) { return Clutter.EVENT_PROPAGATE; }

		let chars = Array.from(clutterText.get_text());
		// The position is the boundary nearest to the click, so a click on the
		// box gives the position just before or just after it
		let pos = clutterText.coords_to_position(x, y);
		let lineStart = getLineStart(chars, pos);
		if (pos - lineStart > 1 || !isTaskBox(chars[lineStart])) {
			return Clutter.EVENT_PROPAGATE;
		}

		let box = chars[lineStart] === TASK_TODO ? TASK_DONE : TASK_TODO;
		let cursor = getCursorPosition(clutterText, chars);
		clutterText.delete_text(lineStart, lineStart + 1);
		clutterText.insert_text(box, lineStart);
		clutterText.set_cursor_position(cursor);
		this.raise();
		return Clutter.EVENT_STOP;
	}

	/*
	 * Pressing Enter in a task creates a new task below it. Pressing Enter in
	 * an empty task removes its box, to end the list. Shift+Enter inserts a
	 * regular line break.
	 */
	_onTaskEnterPress (event) {
		let key = event.get_key_symbol();
		if (key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter) {
			return Clutter.EVENT_PROPAGATE;
		}
		if (event.get_state() & Clutter.ModifierType.SHIFT_MASK) {
			return Clutter.EVENT_PROPAGATE;
		}
		let clutterText = this.noteEntry.get_clutter_text();
		if (clutterText.get_selection()) { return Clutter.EVENT_PROPAGATE; }

		let chars = Array.from(clutterText.get_text());
		let pos = getCursorPosition(clutterText, chars);
		let lineStart = getLineStart(chars, pos);
		if (!isTaskBox(chars[lineStart]) || pos === lineStart) {
			return Clutter.EVENT_PROPAGATE;
		}

		let lineEnd = getLineEnd(chars, lineStart);
		let taskText = chars.slice(lineStart + 1, lineEnd).join('').trim();
		if (taskText === '') {
			clutterText.delete_text(lineStart, lineEnd);
			clutterText.set_cursor_position(lineStart);
		} else {
			clutterText.insert_text('\n' + TASK_TODO + ' ', pos);
			clutterText.set_cursor_position(pos + 3);
		}
		return Clutter.EVENT_STOP;
	}

	/*
	 * Adds a box at the beginning of the line where the cursor is, or removes
	 * it if the line is already a task.
	 */
	_toggleTaskOnCurrentLine () {
		let clutterText = this.noteEntry.get_clutter_text();
		let chars = Array.from(clutterText.get_text());
		let pos = getCursorPosition(clutterText, chars);
		let lineStart = getLineStart(chars, pos);

		if (isTaskBox(chars[lineStart])) {
			let length = chars[lineStart + 1] === ' ' ? 2 : 1;
			clutterText.delete_text(lineStart, lineStart + length);
			clutterText.set_cursor_position(Math.max(lineStart, pos - length));
		} else {
			clutterText.insert_text(TASK_TODO + ' ', lineStart);
			clutterText.set_cursor_position(pos + 2);
		}
		this._getKeyFocus();
	}

	/*
	 * Removes the checked tasks. Called from the options menu.
	 */
	removeDoneTasks () {
		let lines = this.noteEntry.get_text().split('\n');
		lines = lines.filter((line) => line[0] !== TASK_DONE);
		this.noteEntry.set_text(lines.join('\n'));
		this.onlySave(false);
	}

	hasDoneTasks () {
		return countTasks(this.noteEntry.get_text())[0] > 0;
	}

	//--------------------------------------------------------------------------
	// Sticky note's size and position -----------------------------------------

	/*
	 * Coordinates are relative to the note's monitor. If this monitor isn't
	 * connected anymore, the note is shown on the primary monitor instead.
	 */
	_getMonitor () {
		return Main.layoutManager.monitors[this._monitor]
		    ?? Main.layoutManager.primaryMonitor;
	}

	/*
	 * Called when the monitors change, since their coordinates may be
	 * different.
	 */
	updatePosition () {
		this._setNotePosition();
	}

	_setNotePosition () {
		let monitor = this._getMonitor();

		this.actor.set_position(
			monitor.x + Math.floor(this._x),
			monitor.y + Math.floor(this._y)
		);
	}

	_onMovePress (actor, event) {
		let mouseButton = event.get_button();
		if (mouseButton == 3) {
			this._entryBox.visible = !this._entryBox.visible;
			this._footer.visible = this._entryBox.visible;
			this.entry_is_visible = this._entryBox.visible;
		}
		this._onPressCommon(actor, event);
		this._isMoving = true;
		this._isResizing = false;
	}

	_onResizePress (actor, event) {
		this._onPressCommon(actor, event);
		this._isResizing = true;
		this._isMoving = false;
	}

	_onPressCommon (actor, event) {
		this.raise();
		// The pointer can move faster than the note, so the motion events
		// have to be received even when the pointer is outside of the actor
		this._dragGrab = global.stage.grab(actor);
		this.grabX = Math.floor(event.get_coords()[0]);
		this.grabY = Math.floor(event.get_coords()[1]);
	}

	_onResizeMotion (actor, event) {
		if (!this._isResizing) { return; }
		let x = Math.floor(event.get_coords()[0]);
		let y = Math.floor(event.get_coords()[1]);
		this._resizeTo(x, y);
	}

	/*
	 * Resizes the note from its lower-right corner, so its position doesn't
	 * change.
	 */
	_resizeTo (event_x, event_y) {
		let newWidth = this.actor.width + (event_x - this.grabX);
		let newHeight = this.actor.height + (event_y - this.grabY);

		this.actor.width = Math.max(newWidth, MIN_WIDTH);
		this.actor.height = Math.max(newHeight, MIN_HEIGHT);

		this.grabX = event_x;
		this.grabY = event_y;
	}

	_onMoveMotion (actor, event) {
		if (!this._isMoving) { return; }
		let x = Math.floor(event.get_coords()[0]);
		let y = Math.floor(event.get_coords()[1]);
		this._moveTo(x, y);
	}

	_moveTo (event_x, event_y) {
		let newX = event_x - (this.grabX - this._x);
		let newY = event_y - (this.grabY - this._y);

		this._y = Math.floor(newY);
		this._x = Math.floor(newX);
		this._setNotePosition();

		this.grabX = event_x;
		this.grabY = event_y;
	}

	_onRelease (actor, event) {
		this._dragGrab?.dismiss();
		this._dragGrab = null;
		if (this._isMoving) {
			this._updateMonitor();
		}
		this._isResizing = false;
		this._isMoving = false;
		this.onlySave();
	}

	/*
	 * After a move, the note belongs to the monitor where it is now, and its
	 * coordinates become relative to that monitor.
	 */
	_updateMonitor () {
		let index = Main.layoutManager.findIndexForActor(this.actor);
		let monitor = Main.layoutManager.monitors[index];
		if (!monitor) { return; }
		let [absX, absY] = this.actor.get_position();
		this._monitor = index;
		this._x = absX - monitor.x;
		this._y = absY - monitor.y;
	}

	//--------------------------------------------------------------------------
	// "Public" methods called by the NoteOptionsMenu's code -------------------

	changeFontSize (delta) {
		if (this._fontSize + delta > 1) {
			this._fontSize += delta;
			this._applyNoteStyle();
		}
		this.onlySave();
	}

	/*
	 * This applies the color from the menu. Metadata is saved after applying
	 * the new CSS.
	 */
	applyColorAndSave (r, g, b) {
		this._applyColor(r, g, b)
		this.onlySave();
		if (this.pinned) {
			State.notesManager.updatePinnedNotes();
		}
	}

	//--------------------------------------------------------------------------

	_createNote () {
		State.notesManager.createNote(this.customColor, this._fontSize);
	}

	/*
	 * This applies the color, from the menu (`applyColorAndSave`) or the
	 * constructor (direct call). It requires some string manipulations since
	 * the color is saved in the text file using an 'r,g,b' string format. Then,
	 * the text coloration and the CSS is updated.
	 */
	_applyColor (r, g, b) {
		r = Number(r);
		g = Number(g);
		b = Number(b);
		if (Number.isNaN(r)) r = 255;
		if (Number.isNaN(g)) g = 255;
		if (Number.isNaN(b)) b = 255;
		r = Math.min(Math.max(0, r), 255);
		g = Math.min(Math.max(0, g), 255);
		b = Math.min(Math.max(0, b), 255);
		this.customColor = r.toString() + ',' + g.toString() + ',' + b.toString();
		// Perceived brightness of the color
		if (0.299 * r + 0.587 * g + 0.114 * b > 140) {
			this._fontColor = 'rgba(0, 0, 0, 0.8)';
		} else {
			this._fontColor = '#ffffff';
		}
		this._applyNoteStyle();
		this._applyActorStyle();
	}

	_loadText () {
		let file2 = GLib.build_filenamev([PATH, this.id.toString() + '_text']);
		if (!GLib.file_test(file2, GLib.FileTest.EXISTS)) {
			GLib.file_set_contents(file2, '');
		}

		let file = Gio.file_new_for_path(PATH + '/' + this.id.toString() + '_text');
		let [result, contents] = file.load_contents(null);
		if (!result) {
			console.log('Could not read file: ' + PATH);
		}
		let content = stringFromArray(contents);

		this.noteEntry.set_text(content);
	}

	_saveText () {
		let noteText = this.noteEntry.get_text();
		if (noteText == null) {
			noteText = '';
		}
		let file = GLib.build_filenamev([PATH, this.id.toString() + '_text']);
		GLib.file_set_contents(file, noteText);
	}

	/*
	 * This tries to find a random [x,y] which doesn't overlap with an existing
	 * note's header and which isn't out of the primary monitor. Of course, if
	 * there is notes everywhere, it just abandons computation, and sets the
	 * note in a random position (within the monitor or course).
	 */
	_computeRandomPosition () {
		let x;
		let y;
		for(var i = 0; i < 15; i++) {
			x = Math.random() * (Main.layoutManager.primaryMonitor.width - 300);
			y = Math.random() * (Main.layoutManager.primaryMonitor.height - 100);

			if (State.notesManager.areCoordsUsable(x, y)) {
				return [x, y];
			}
		}
		return [x, y];
	}

	_createDefaultState (fileName) {
		let defaultPosition = this._computeRandomPosition();
		let defaultContent = defaultPosition[0].toString() + ';'
		                   + defaultPosition[1].toString() + ';'
		                   + this.customColor + ';250;180;'
		                   + this._fontSize + ';true;false;'
		                   + Main.layoutManager.primaryIndex + ';;'
		GLib.file_set_contents(fileName, defaultContent);
		return defaultContent;
	}

	_loadState () {
		let fname = GLib.build_filenamev([PATH, this.id.toString() + '_state']);
		if (!GLib.file_test(fname, GLib.FileTest.EXISTS)) {
			// If a _text file has no corresponding _state file
			this._createDefaultState(fname);
		}

		let file = Gio.file_new_for_path(fname);
		let [result, contents] = file.load_contents(null);
		let stringContent;
		if (!result) {
			console.log("Could not read sticky note state file: " + fname);
			stringContent = this._createDefaultState(fname);
		} else {
			stringContent = stringFromArray(contents);
		}

		let state = stringContent.split(';');
		this._x = Number(state[0]);
		this._y = Number(state[1]);
		this.customColor = state[2];
		this.actor.width = Number(state[3]);
		this.actor.height = Number(state[4]);
		this._fontSize = Number(state[5]);
		this.entry_is_visible = (state[6] == 'true');
		// The next values are absent from the files saved by older versions of
		// the extension
		this.hidden = (state[7] == 'true');
		this._monitor = (state[8] === undefined || state[8] === '')
			? Main.layoutManager.primaryIndex
			: Number(state[8]);
		this._title = '';
		try {
			this._title = decodeURIComponent(state[9] ?? '');
		} catch (e) {
			console.log('Invalid title for note n°' + this.id.toString());
		}
		this.pinned = (state[10] == 'true');
	}

	/*
	 * The title is encoded, so it can't contain the ';' separator.
	 */
	_getStateString () {
		let noteState = '';
		noteState += this._x.toString() + ';';
		noteState += this._y.toString() + ';';
		noteState += this.customColor.toString() + ';';
		noteState += this.actor.width.toString() + ';';
		noteState += this.actor.height.toString() + ';';
		noteState += this._fontSize.toString() + ';';
		noteState += this.entry_is_visible.toString() + ';';
		noteState += this.hidden.toString() + ';';
		noteState += this._monitor.toString() + ';';
		noteState += encodeURIComponent(this._title) + ';';
		noteState += this.pinned.toString() + ';';
		return noteState;
	}

	_saveState () {
		let file = GLib.build_filenamev([PATH, this.id.toString() + '_state']);
		GLib.file_set_contents(file, this._getStateString());
	}

	//--------------------------------------------------------------------------

	/*
	 * The text and the state are kept by the NotesManager, so the deletion can
	 * be cancelled.
	 */
	_deleteNoteObject () {
		let noteId = this.id;
		let text = this.noteEntry.get_text();
		let state = this._getStateString();
		this.destroy();
		State.notesManager.postDelete(noteId);
		if (text !== '') {
			State.notesManager.onNoteDeleted(text, state);
		}
	}

	destroy () {
		if (this._saveTimeoutId) {
			GLib.source_remove(this._saveTimeoutId);
			this._saveTimeoutId = null;
		}
		this._dragGrab?.dismiss();
		this._dragGrab = null;
		this.actor.destroy_all_children();
		this.actor.destroy();
		this.actor = null;
	}
}

//------------------------------------------------------------------------------
