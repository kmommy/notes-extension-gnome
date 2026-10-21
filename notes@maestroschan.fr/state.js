// notes@maestroschan.fr/state.js
// GPL v3
// Copyright 2018-2021 Romain F. T.

// Values shared between the modules of the extension. ES modules can't assign
// to each other's exports, so they are stored as properties of this object,
// and set by the extension's enable() method.
export const State = {
	extension: null,
	notesManager: null,
	settings: null,
};
