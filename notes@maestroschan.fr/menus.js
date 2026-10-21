// notes@maestroschan.fr/menus.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {State} from './state.js';

// The light colors of the GNOME color palette
const PRESET_COLORS = {
	'yellow': [249, 240, 107],
	'orange': [255, 190, 111],
	'red': [246, 97, 81],
	'purple': [220, 138, 221],

	'blue': [153, 193, 241],
	'green': [143, 240, 164],
	'brown': [205, 171, 143],
	'white': [255, 255, 255]
};

//------------------------------------------------------------------------------

function rgbToHex(rgb) {
	return '#' + rgb.map((c) => Number(c).toString(16).padStart(2, '0')).join('');
}

/*
 * Accepts '#rrggbb' or '#rgb' (the '#' is optional), and returns [r, g, b], or
 * null if the text isn't a valid color.
 */
function parseHexColor(text) {
	let hex = text.trim().replace(/^#/, '');
	if (/^[0-9a-f]{3}$/i.test(hex)) {
		hex = hex.split('').map((c) => c + c).join('');
	}
	if (!/^[0-9a-f]{6}$/i.test(hex)) {
		return null;
	}
	return [0, 2, 4].map((i) => parseInt(hex.substring(i, i + 2), 16));
}

//------------------------------------------------------------------------------

class NoteOptionsMenu extends Signals.EventEmitter {
	constructor (source) {
		super();
		this.super_menu = new PopupMenu.PopupMenu(source.actor, 0.5, St.Side.TOP);

		// We want to keep the item hovered while the menu is up
		this.super_menu.blockSourceEvents = true;
		this._source = source;

		// Chain our visibility and lifecycle to that of the source
		source.actor.connect('notify::mapped', () => {
			if (!source.actor.mapped) {
				this.super_menu.close();
			}
		});
		source.actor.connect('destroy', this.super_menu.destroy.bind(this.super_menu));

		Main.uiGroup.add_child(this.super_menu.actor);
	}

	_redisplay () {
		this.super_menu.removeAll(); //-----------------------------------------

		this.super_menu.addAction(_("Edit title"), this._onEditTitle.bind(this));

		let pinItem = new PopupMenu.PopupSwitchMenuItem(
			_("Show in the top bar and overview"),
			this._source._note.pinned
		);
		pinItem.connect('toggled', (item, state) => {
			this._source._note.setPinned(state);
		});
		this.super_menu.addMenuItem(pinItem);

		if (this._source._note.hasDoneTasks()) {
			this.super_menu.addAction(
				_("Remove checked tasks"),
				this._onRemoveDoneTasks.bind(this)
			);
		}

		this._appendSeparator(); //---------------------------------------------

		this.size_item = new PopupMenu.PopupBaseMenuItem({
			reactive: false,
			activate: false,
			hover: false,
			style_class: null,
			can_focus: false
		});
		this.super_menu.addMenuItem(this.size_item);
		this._buildSizeItem();

		this._appendSeparator(); //---------------------------------------------

		this.color1_item = new PopupMenu.PopupBaseMenuItem({
			reactive: false,
			activate: false,
			hover: false,
			style_class: null,
			can_focus: false
		});
		this._addColorButton('yellow', 1);
		this._addColorButton('orange', 1);
		this._addColorButton('red', 1);
		this._addColorButton('purple', 1);
		this.super_menu.addMenuItem(this.color1_item);

		this.color2_item = new PopupMenu.PopupBaseMenuItem({
			reactive: false,
			activate: false,
			hover: false,
			style_class: null,
			can_focus: false
		});
		this._addColorButton('blue', 2);
		this._addColorButton('green', 2);
		this._addColorButton('brown', 2);
		this._addColorButton('white', 2);
		this.super_menu.addMenuItem(this.color2_item);

		let colorSubmenuItem = new PopupMenu.PopupSubMenuMenuItem(_("Custom color"));
		this.super_menu.addMenuItem(colorSubmenuItem);
		this._buildCustomColorMenu(colorSubmenuItem.menu);

		this._appendSeparator(); //---------------------------------------------

		this.super_menu.addAction(_("Settings"), this._onSettings);
	}

	_buildCustomColorMenu (colorSubmenu) {
		let colorMenuItem = new PopupMenu.PopupBaseMenuItem({
			reactive: false,
			activate: false,
			hover: false,
			style_class: null,
			can_focus: false
		});

		let rgb = this._source._note.customColor.split(',');
		this._hexEntry = new St.Entry({
			text: rgbToHex(rgb),
			hint_text: '#rrggbb',
			can_focus: true,
			track_hover: true,
			x_expand: true,
			style_class: 'notesHexEntry',
		});
		this._hexEntry.clutter_text.connect('activate', this._onApplyCustom.bind(this));
		this._hexEntry.clutter_text.connect('text-changed', () => {
			this._hexEntry.remove_style_pseudo_class('error');
		});
		colorMenuItem.add_child(this._hexEntry);
		colorSubmenu.addMenuItem(colorMenuItem);

		let applyMenuItem = new PopupMenu.PopupMenuItem(_("Apply"));
		applyMenuItem.connect('activate', this._onApplyCustom.bind(this));
		colorSubmenu.addMenuItem(applyMenuItem);
	}

	_buildSizeItem () {
		let sizeLabel = new St.Label({
			text: _("Font size"),
			x_expand: true,
			x_align: Clutter.ActorAlign.START,
			y_align: Clutter.ActorAlign.CENTER,
		});

		let smaller = this._buildIconButton('list-remove-symbolic', _("Smaller"));
		let bigger = this._buildIconButton('list-add-symbolic', _("Bigger"));

		smaller.connect('clicked', this._onSmaller.bind(this));
		bigger.connect('clicked', this._onBigger.bind(this));

		this.size_item.add_child(sizeLabel);
		this.size_item.add_child(smaller);
		this.size_item.add_child(bigger);
	}

	_buildIconButton (iconName, accessibleName) {
		return new St.Button({
			style_class: 'icon-button notesMenuButton',
			accessible_name: accessibleName,
			can_focus: true,
			child: new St.Icon({
				icon_name: iconName,
				icon_size: 16,
			}),
		});
	}

	_addColorButton (color, line) {
		let rgb = PRESET_COLORS[color];
		let btn = new St.Button({
			style_class: 'notesColorButton',
			style: 'background-color: rgb(' + rgb[0] + ','
			                                + rgb[1] + ','
			                                + rgb[2] + ');',
			can_focus: true,
			x_expand: true,
			x_align: Clutter.ActorAlign.CENTER,
		});
		if (rgb.toString() === this._source._note.customColor) {
			btn.add_style_pseudo_class('checked');
		}
		if (line == 1) {
			this.color1_item.add_child(btn);
		} else {
			this.color2_item.add_child(btn);
		}
		btn.connect('clicked', this._onApply.bind(this, color));
	}

	_appendSeparator () {
		this.super_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
	}

	_onApplyCustom () {
		let rgb = parseHexColor(this._hexEntry.get_text());
		if (rgb === null) {
			this._hexEntry.add_style_pseudo_class('error');
			return;
		}
		this._source._note.applyColorAndSave(rgb[0], rgb[1], rgb[2]);
		this.super_menu.close();
	}

	_onRemoveDoneTasks () {
		this._source._note.removeDoneTasks();
	}

	_onSettings () {
		State.extension.openPreferences();
		State.notesManager._hideNotes();
	}

	_onEditTitle () {
		this._source._note.openEditTitleDialog();
	}

	_onApply (color, button) {
		let rgb = PRESET_COLORS[color];
		this._source._note.applyColorAndSave(rgb[0], rgb[1], rgb[2]);
		this.super_menu.close();
	}

	popup (activatingButton) {
		this._redisplay();
		this.super_menu.toggle();//.open();
	}

	_onBigger () {
		this._source._note.changeFontSize(1);
	}

	_onSmaller () {
		this._source._note.changeFontSize(-1);
	}
}

//------------------------------------------------------------------------------

export class NoteRoundButton extends Signals.EventEmitter {
	constructor (note, icon, accessibleName) {
		super();
		this._note = note;
		this.actor = new St.Button({
			child: new St.Icon({
				icon_name: icon,
				icon_size: 16,
			}),
			accessible_name: accessibleName,
			y_align: Clutter.ActorAlign.CENTER,
			style_class: 'notesHeaderboxButton',
			reactive: true,
			can_focus: true,
			track_hover: true,
			y_expand: false,
		});
	}

	//----------------------- If the button has a menu -------------------------

	addMenu () {
		this._menu = null;
		this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
		this.actor.connect('clicked', this.popupMenu.bind(this));
	}

	popupMenu () {
		if (!this._menu) {
			this._menu = new NoteOptionsMenu(this);
			this._menu.super_menu.connect('open-state-changed', (menu, isPoppedUp) => {
				if (!isPoppedUp) {
					this.actor.sync_hover();
					this.emit('menu-state-changed', false);
				}
			});
			this._menuManager.addMenu(this._menu.super_menu);
		}
		this.emit('menu-state-changed', true);
		this.actor.set_hover(true);
		this._menu.popup();
		return false;
	}

	isMenuOpen () {
		return this._menu?.super_menu.isOpen ?? false;
	}
}

//------------------------------------------------------------------------------

