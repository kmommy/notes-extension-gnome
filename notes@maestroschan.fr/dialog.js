// notes@maestroschan.fr/dialog.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const CustomModalDialog = GObject.registerClass(
class CustomModalDialog extends ModalDialog.ModalDialog {
	_init(textTitle, textDescription, textOkButton, callback) {
		super._init();

		// The same layout as the other dialogs of GNOME Shell
		let content = new Dialog.MessageDialogContent({
			title: textTitle,
			description: textDescription,
		});
		this.contentLayout.add_child(content);

		// The method to add buttons is herited from ModalDialog
		this.setButtons([{
			label: _("Cancel"),
			action: () => { this.close(); },
			key: Clutter.KEY_Escape
		}, {
			label: textOkButton,
			action: () => {
				this.close();
				callback();
			}
		}]);
	}
});
