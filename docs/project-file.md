# Project file

A project file is the versioned JSON document the editor already stores in IndexedDB (`SerializedProject`). Export writes that document to disk. Import reads it, runs it through the storage migration runner, and opens it as a project.

The file is the contract a script or a model can write to build a timeline without clicking in the UI.

## Media

Media bytes are not part of the file. Video, image, and uploaded-audio clips keep their `mediaId` string, and the bytes stay in the browser (IndexedDB + OPFS, keyed by project id).

On import, each `mediaId` is checked against the media already stored for that project:

- If the id is still in this browser, the clip keeps working.
- If it is missing, import still opens the project and reports a warning naming the clip and the missing id. Re-import the original file into the project afterwards.

Stickers, graphics, and library audio (a `sourceUrl`) do not use this store, so they are not warned about.

Import keeps `metadata.id` when that project is not already stored. If it is, the file is saved as a copy with a new id and a `" copy"` suffix on the name, and every media reference is treated as missing because the new project has an empty media store.

## Version

`version` is required on files this editor writes. It is an integer. The current version is **31** (`CURRENT_PROJECT_VERSION`).

- A higher version is rejected.
- A lower version is passed through `migrateProjectRecord` in `apps/web/src/services/storage/migrations/runner.ts`, the same chain `runStorageMigrations` uses, one step at a time.
- Files from version 1 may be missing tracks that lived in a side database. A JSON-only import cannot recover those tracks.

Times are integer ticks, not seconds. One second is 120000 ticks (`TICKS_PER_SECOND` from `opencut-wasm`).

## Minimal example

[`docs/examples/minimal-project.json`](examples/minimal-project.json) is one scene, the required empty main video track, one text track, and one text clip that lasts 5 seconds (`600000` ticks). The words on screen are `params.content`.

Every scene needs `tracks.main` (a video track), `tracks.overlay` (text, video, graphic, and effect tracks), and `tracks.audio`.

## Errors

Import rejects the file before opening a project when the JSON cannot be migrated into the current shape. The message lists what is wrong, for example:

- the file is not JSON, or not an object
- `version` is missing a type, or is newer than this editor
- `metadata.id` / `metadata.name` are missing
- `currentSceneId` does not match a scene
- a clip `type` is unknown, or a video clip has no `mediaId`
- migration stopped before version 31

Effects, masks, and keyframes are kept as stored and are not fully schema-checked in this first version.
