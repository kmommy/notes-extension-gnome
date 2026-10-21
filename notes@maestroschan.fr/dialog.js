// notes@maestroschan.fr/dialog.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const CustomModalDialog = GObject.registerClass(
class CustomModalDialog extends ModalDialog.ModalDialog {
	/*
	 * If `entryText` is a string, the dialog contains a text field initialized
	 * with it, and the callback receives the text of this field.
	 */
	_init(textTitle, textDescription, textOkButton, callback, entryText=null) {
		super._init();

		// The same layout as the other dialogs of GNOME Shell
		let content = new Dialog.MessageDialogContent({
			title: textTitle,
			description: textDescription,
		});
		this.contentLayout.add_child(content);

		let entry = null;
		if (entryText !== null) {
			entry = new St.Entry({
				text: entryText,
				can_focus: true,
				x_expand: true,
				style_class: 'notesDialogEntry',
			});
			entry.clutter_text.connect('activate', () => {
				this.close();
				callback(entry.get_text());
			});
			this.contentLayout.add_child(entry);
			this.setInitialKeyFocus(entry);
		}

		// The method to add buttons is herited from ModalDialog
		this.setButtons([{
			label: _("Cancel"),
			action: () => { this.close(); },
			key: Clutter.KEY_Escape
		}, {
			label: textOkButton,
			action: () => {
				this.close();
				callback(entry?.get_text());
			}
		}]);
	}
});
