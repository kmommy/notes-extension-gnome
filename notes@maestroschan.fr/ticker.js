// notes@maestroschan.fr/ticker.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Maximal width (in pixels) of the scrolling text in the top bar
const TICKER_MAX_WIDTH = 300;

// Speed of the scrolling text, in pixels per second
const TICKER_SPEED = 60;

// Separator between the notes in the scrolling text
const NOTES_SEPARATOR = '     •     ';

// Maximal number of lines of a note shown in the overview
const OVERVIEW_MAX_LINES = 8;

//------------------------------------------------------------------------------

/*
 * The text of the pinned notes, in the top bar. If it's too long for the
 * available width, it scrolls from right to left, endlessly.
 */
export class PanelTicker {
	constructor () {
		// Without layout manager, the label keeps its natural width, and the
		// part outside of the actor is clipped
		this.actor = new St.Widget({
			clip_to_allocation: true,
			y_align: Clutter.ActorAlign.CENTER,
			style_class: 'notesTicker',
			visible: false,
		});
		this._label = new St.Label({ text: '' });
		this.actor.add_child(this._label);

		// The width of the label is only known once it is on the stage
		this._label.connect('notify::width', this._restartScrolling.bind(this));
	}

	setNotes (notes) {
		let text = notes.map((n) => n.getInlineText()).join(NOTES_SEPARATOR);
		this.actor.visible = (text !== '');
		if (text !== this._label.text) {
			this._label.text = text;
			this._restartScrolling();
		}
	}

	_restartScrolling () {
		this._label.remove_transition('notes-ticker');
		this._label.translation_x = 0;

		let labelWidth = this._label.width;
		this.actor.width = Math.min(labelWidth, TICKER_MAX_WIDTH);
		if (labelWidth <= TICKER_MAX_WIDTH) {
			return;
		}

		// The text enters from the right edge and leaves by the left edge
		let distance = TICKER_MAX_WIDTH + labelWidth;
		let transition = new Clutter.PropertyTransition({
			property_name: 'translation-x',
			duration: Math.round(distance / TICKER_SPEED * 1000),
			progress_mode: Clutter.AnimationMode.LINEAR,
			repeat_count: -1,
		});
		transition.set_from(TICKER_MAX_WIDTH);
		transition.set_to(-labelWidth);
		this._label.add_transition('notes-ticker', transition);
	}

	destroy () {
		this._label.remove_transition('notes-ticker');
		this.actor.destroy();
	}
}

//------------------------------------------------------------------------------

/*
 * The pinned notes, as small cards in the upper-left corner of the overview
 * (shown with the Super key). Clicking a card shows the note on the desktop.
 */
export class OverviewNotes {
	constructor (onCardClicked) {
		this._onCardClicked = onCardClicked;
		this.actor = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			style_class: 'notesOverviewBox',
			visible: false,
		});
		Main.layoutManager.overviewGroup.add_child(this.actor);
		this.updatePosition();
	}

	setNotes (notes) {
		this.actor.destroy_all_children();
		notes.forEach((n) => {
			this.actor.add_child(this._buildCard(n));
		});
		this.actor.visible = (notes.length > 0);
	}

	_buildCard (note) {
		let [backgroundColor, fontColor] = note.getColors();
		let box = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
		});

		let title = note.getPinnedTitle();
		if (title !== '') {
			box.add_child(new St.Label({
				text: title,
				style_class: 'notesOverviewCardTitle',
			}));
		}

		let lines = note.getTextLines();
		if (lines.length > OVERVIEW_MAX_LINES) {
			lines = lines.slice(0, OVERVIEW_MAX_LINES).concat(['…']);
		}
		let textLabel = new St.Label({ text: lines.join('\n') });
		textLabel.clutter_text.line_wrap = true;
		textLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
		textLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
		box.add_child(textLabel);

		let card = new St.Button({
			child: box,
			x_expand: true,
			can_focus: true,
			style_class: 'notesOverviewCard',
			style: 'background-color: rgb(' + backgroundColor + '); color: ' + fontColor + ';',
		});
		card.connect('clicked', () => {
			this._onCardClicked(note);
		});
		return card;
	}

	/*
	 * Called when the monitors change, since the cards are on the primary one.
	 */
	updatePosition () {
		let monitor = Main.layoutManager.primaryMonitor;
		if (!monitor) { return; }
		this.actor.set_position(monitor.x + 24, monitor.y + Main.panel.height + 24);
	}

	destroy () {
		this.actor.destroy();
	}
}

//------------------------------------------------------------------------------

