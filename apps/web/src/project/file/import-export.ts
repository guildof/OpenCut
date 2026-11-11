import {
	CURRENT_PROJECT_VERSION,
	getProjectVersion,
	migrateProjectRecord,
	migrations,
} from "@/services/storage/migrations";
import { getProjectId, isRecord } from "@/services/storage/migrations/transformers/utils";
import {
	deserializeProject,
	serializeProject,
} from "@/services/storage/serialize-project";
import type { SerializedProject } from "@/services/storage/types";
import type { TProject } from "@/project/types";
import type { ProjectRecord } from "@/services/storage/migrations/transformers/types";
import type { TimelineTrack, TrackType } from "@/timeline";

const CLIP_TYPES = new Set<string>([
	"audio",
	"video",
	"image",
	"text",
	"sticker",
	"graphic",
	"effect",
]);

const OVERLAY_TRACK_TYPES = new Set<TrackType>([
	"video",
	"text",
	"graphic",
	"effect",
]);

export class ProjectFileError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(issues.length === 1 ? issues[0] : issues.map((issue) => `• ${issue}`).join("\n"));
		this.name = "ProjectFileError";
		this.issues = issues;
	}
}

export interface MediaReference {
	mediaId: string;
	name: string;
}

export function projectFileName({ name }: { name: string }): string {
	const safe =
		name
			.trim()
			.replace(/[^\w.-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project";
	return `${safe}.opencut.json`;
}

export function projectFileJson({ project }: { project: TProject }): string {
	return `${JSON.stringify(serializeProject({ project }), null, 2)}\n`;
}

export async function importProjectDocument({
	text,
	availableMediaIds = [],
}: {
	text: string;
	availableMediaIds?: readonly string[];
}): Promise<{ project: TProject; warnings: string[] }> {
	const record = parseProjectFile({ text });
	const migrated = await migrateProjectRecord({
		project: record,
		migrations,
	});

	if (!getProjectId({ project: migrated.project })) {
		throw new ProjectFileError([
			'Project file is missing an id. Set "metadata.id" to a non-empty string.',
		]);
	}

	const version = getProjectVersion({ project: migrated.project });
	if (migrated.stoppedAt !== null || version !== CURRENT_PROJECT_VERSION) {
		const stopped = migrated.stoppedAt ?? version;
		throw new ProjectFileError([
			`Could not migrate this project to version ${CURRENT_PROJECT_VERSION} (stopped at version ${stopped}).`,
		]);
	}

	assertCurrentSerializedProject(migrated.project);

	const project = deserializeProject({
		serializedProject: migrated.project,
	});

	return {
		project,
		warnings: missingMediaWarnings({
			project,
			availableMediaIds: new Set(availableMediaIds),
		}),
	};
}

export function collectMediaReferences({
	project,
}: {
	project: TProject;
}): MediaReference[] {
	const references: MediaReference[] = [];
	for (const scene of project.scenes) {
		const tracks: TimelineTrack[] = [
			...scene.tracks.overlay,
			scene.tracks.main,
			...scene.tracks.audio,
		];
		for (const track of tracks) {
			for (const element of track.elements) {
				if (!("mediaId" in element) || typeof element.mediaId !== "string") {
					continue;
				}
				if (element.type === "audio" && element.sourceType !== "upload") {
					continue;
				}
				references.push({ mediaId: element.mediaId, name: element.name });
			}
		}
	}
	return references;
}

export function missingMediaWarnings({
	project,
	availableMediaIds,
}: {
	project: TProject;
	availableMediaIds: ReadonlySet<string>;
}): string[] {
	const seen = new Set<string>();
	const missing: MediaReference[] = [];
	for (const reference of collectMediaReferences({ project })) {
		if (availableMediaIds.has(reference.mediaId) || seen.has(reference.mediaId)) {
			continue;
		}
		seen.add(reference.mediaId);
		missing.push(reference);
	}
	if (missing.length === 0) {
		return [];
	}

	const listed = missing.slice(0, 8).map(
		(reference) =>
			`"${reference.name}" points at media "${reference.mediaId}", which is not in this file.`,
	);
	if (missing.length > 8) {
		listed.push(`And ${missing.length - 8} more media files are missing.`);
	}
	return [
		"This project file does not include media bytes. Re-import the original files into the project.",
		...listed,
	];
}

function parseProjectFile({ text }: { text: string }): ProjectRecord {
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (!trimmed) {
		throw new ProjectFileError(["The file is empty."]);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new ProjectFileError(["This file is not valid JSON."]);
	}

	if (Array.isArray(parsed) || !isRecord(parsed)) {
		throw new ProjectFileError(["A project file must be a JSON object."]);
	}

	if ("version" in parsed && parsed.version !== undefined) {
		const version = parsed.version;
		if (typeof version !== "number" || !Number.isInteger(version)) {
			throw new ProjectFileError(['"version" must be an integer.']);
		}
		if (version < 0) {
			throw new ProjectFileError(['"version" must be 0 or greater.']);
		}
		if (version > CURRENT_PROJECT_VERSION) {
			throw new ProjectFileError([
				`This file uses project version ${version}. This editor supports up to version ${CURRENT_PROJECT_VERSION}.`,
			]);
		}
	}

	if (!getProjectId({ project: parsed })) {
		throw new ProjectFileError([
			'Project file is missing an id. Set "metadata.id" to a non-empty string.',
		]);
	}

	return parsed;
}

function assertCurrentSerializedProject(
	project: ProjectRecord,
): asserts project is SerializedProject {
	const issues = validateCurrentProject({ project });
	if (issues.length > 0) {
		throw new ProjectFileError(issues);
	}
}

function validateCurrentProject({ project }: { project: ProjectRecord }): string[] {
	const issues: string[] = [];
	const metadata = project.metadata;
	if (!isRecord(metadata)) {
		return ['Project file is missing "metadata".'];
	}

	if (typeof metadata.id !== "string" || metadata.id.length === 0) {
		issues.push('"metadata.id" must be a non-empty string.');
	}
	if (typeof metadata.name !== "string" || metadata.name.trim().length === 0) {
		issues.push('"metadata.name" must be a non-empty string.');
	}
	requireIsoDate({
		issues,
		value: metadata.createdAt,
		path: "metadata.createdAt",
	});
	requireIsoDate({
		issues,
		value: metadata.updatedAt,
		path: "metadata.updatedAt",
	});
	requireInteger({
		issues,
		value: metadata.duration,
		path: "metadata.duration",
	});
	if (metadata.thumbnail !== undefined && typeof metadata.thumbnail !== "string") {
		issues.push('"metadata.thumbnail" must be a string when present.');
	}

	if (!isRecord(project.settings)) {
		issues.push('Project file is missing "settings".');
	} else {
		validateSettings({ issues, settings: project.settings });
	}

	if (!Array.isArray(project.scenes) || project.scenes.length === 0) {
		issues.push("Project file must include at least one scene.");
		return issues;
	}

	const sceneIds = new Set<string>();
	for (const [index, scene] of project.scenes.entries()) {
		validateScene({ issues, scene, index, sceneIds });
	}

	if (
		typeof project.currentSceneId !== "string" ||
		!sceneIds.has(project.currentSceneId)
	) {
		issues.push('"currentSceneId" must match the id of a scene in the file.');
	}

	if (project.timelineViewState !== undefined) {
		validateTimelineViewState({ issues, value: project.timelineViewState });
	}

	if (project.version !== CURRENT_PROJECT_VERSION) {
		issues.push(
			`"version" must be ${CURRENT_PROJECT_VERSION} after migration.`,
		);
	}

	return issues;
}

function validateSettings({
	issues,
	settings,
}: {
	issues: string[];
	settings: ProjectRecord;
}): void {
	const canvasSize = settings.canvasSize;
	if (
		!isRecord(canvasSize) ||
		!isPositiveInteger(canvasSize.width) ||
		!isPositiveInteger(canvasSize.height)
	) {
		issues.push(
			'"settings.canvasSize" must be { "width", "height" } positive integers.',
		);
	}

	const fps = settings.fps;
	if (
		!isRecord(fps) ||
		!isPositiveInteger(fps.numerator) ||
		!isPositiveInteger(fps.denominator)
	) {
		issues.push(
			'"settings.fps" must be { "numerator", "denominator" } positive integers.',
		);
	}

	const background = settings.background;
	if (!isRecord(background)) {
		issues.push('Project file is missing "settings.background".');
		return;
	}
	if (background.type === "color") {
		if (typeof background.color !== "string" || background.color.length === 0) {
			issues.push('"settings.background.color" must be a non-empty string.');
		}
		return;
	}
	if (background.type === "blur") {
		if (typeof background.blurIntensity !== "number") {
			issues.push('"settings.background.blurIntensity" must be a number.');
		}
		return;
	}
	issues.push('"settings.background.type" must be "color" or "blur".');
}

function validateScene({
	issues,
	scene,
	index,
	sceneIds,
}: {
	issues: string[];
	scene: unknown;
	index: number;
	sceneIds: Set<string>;
}): void {
	const path = `scenes[${index}]`;
	if (!isRecord(scene)) {
		issues.push(`${path} must be an object.`);
		return;
	}
	if (typeof scene.id !== "string" || scene.id.length === 0) {
		issues.push(`${path}.id must be a non-empty string.`);
	} else if (sceneIds.has(scene.id)) {
		issues.push(`${path}.id "${scene.id}" is duplicated.`);
	} else {
		sceneIds.add(scene.id);
	}
	if (typeof scene.name !== "string" || scene.name.length === 0) {
		issues.push(`${path}.name must be a non-empty string.`);
	}
	if (typeof scene.isMain !== "boolean") {
		issues.push(`${path}.isMain must be a boolean.`);
	}
	requireIsoDate({ issues, value: scene.createdAt, path: `${path}.createdAt` });
	requireIsoDate({ issues, value: scene.updatedAt, path: `${path}.updatedAt` });
	if (scene.bookmarks !== undefined && !Array.isArray(scene.bookmarks)) {
		issues.push(`${path}.bookmarks must be an array when present.`);
	}

	const tracks = scene.tracks;
	if (!isRecord(tracks)) {
		issues.push(`${path}.tracks must be an object.`);
		return;
	}
	validateTrack({
		issues,
		track: tracks.main,
		path: `${path}.tracks.main`,
		allowedTypes: new Set(["video"]),
		role: "main",
	});
	validateTrackList({
		issues,
		tracks: tracks.overlay,
		path: `${path}.tracks.overlay`,
		allowedTypes: OVERLAY_TRACK_TYPES,
	});
	validateTrackList({
		issues,
		tracks: tracks.audio,
		path: `${path}.tracks.audio`,
		allowedTypes: new Set(["audio"]),
	});
}

function validateTrackList({
	issues,
	tracks,
	path,
	allowedTypes,
}: {
	issues: string[];
	tracks: unknown;
	path: string;
	allowedTypes: ReadonlySet<string>;
}): void {
	if (!Array.isArray(tracks)) {
		issues.push(`${path} must be an array.`);
		return;
	}
	for (const [index, track] of tracks.entries()) {
		validateTrack({
			issues,
			track,
			path: `${path}[${index}]`,
			allowedTypes,
			role: "list",
		});
	}
}

function validateTrack({
	issues,
	track,
	path,
	allowedTypes,
	role,
}: {
	issues: string[];
	track: unknown;
	path: string;
	allowedTypes: ReadonlySet<string>;
	role: "main" | "list";
}): void {
	if (!isRecord(track)) {
		issues.push(`${path} must be an object.`);
		return;
	}
	if (typeof track.type !== "string" || !allowedTypes.has(track.type)) {
		const expected =
			role === "main" ? '"video"' : [...allowedTypes].map((type) => `"${type}"`).join(", ");
		issues.push(`${path}.type must be ${expected}.`);
	}
	if (typeof track.id !== "string" || track.id.length === 0) {
		issues.push(`${path}.id must be a non-empty string.`);
	}
	if (typeof track.name !== "string") {
		issues.push(`${path}.name must be a string.`);
	}
	if (track.type === "audio" || track.type === "video") {
		if (typeof track.muted !== "boolean") {
			issues.push(`${path}.muted must be a boolean.`);
		}
	}
	if (track.type !== "audio" && typeof track.hidden !== "boolean") {
		issues.push(`${path}.hidden must be a boolean.`);
	}
	if (!Array.isArray(track.elements)) {
		issues.push(`${path}.elements must be an array.`);
		return;
	}
	for (const [index, element] of track.elements.entries()) {
		validateElement({ issues, element, path: `${path}.elements[${index}]` });
	}
}

function validateElement({
	issues,
	element,
	path,
}: {
	issues: string[];
	element: unknown;
	path: string;
}): void {
	if (!isRecord(element)) {
		issues.push(`${path} must be an object.`);
		return;
	}
	if (typeof element.type !== "string" || !CLIP_TYPES.has(element.type)) {
		issues.push(
			`${path}.type must be one of ${[...CLIP_TYPES].map((type) => `"${type}"`).join(", ")}.`,
		);
		return;
	}
	if (typeof element.id !== "string" || element.id.length === 0) {
		issues.push(`${path}.id must be a non-empty string.`);
	}
	if (typeof element.name !== "string") {
		issues.push(`${path}.name must be a string.`);
	}
	for (const key of ["duration", "startTime", "trimStart", "trimEnd"] as const) {
		requireInteger({ issues, value: element[key], path: `${path}.${key}` });
	}
	if (!isRecord(element.params)) {
		issues.push(`${path}.params must be an object.`);
	}

	if (
		(element.type === "video" || element.type === "image") &&
		(typeof element.mediaId !== "string" || element.mediaId.length === 0)
	) {
		issues.push(`${path}.mediaId must be a non-empty string.`);
	}
	if (element.type === "audio") {
		if (element.sourceType !== "upload" && element.sourceType !== "library") {
			issues.push(`${path}.sourceType must be "upload" or "library".`);
		} else if (
			element.sourceType === "upload" &&
			(typeof element.mediaId !== "string" || element.mediaId.length === 0)
		) {
			issues.push(`${path}.mediaId must be a non-empty string for uploaded audio.`);
		} else if (
			element.sourceType === "library" &&
			(typeof element.sourceUrl !== "string" || element.sourceUrl.length === 0)
		) {
			issues.push(`${path}.sourceUrl must be a non-empty string for library audio.`);
		}
	}
	if (
		element.type === "sticker" &&
		(typeof element.stickerId !== "string" || element.stickerId.length === 0)
	) {
		issues.push(`${path}.stickerId must be a non-empty string.`);
	}
	if (
		element.type === "graphic" &&
		(typeof element.definitionId !== "string" || element.definitionId.length === 0)
	) {
		issues.push(`${path}.definitionId must be a non-empty string.`);
	}
	if (
		element.type === "effect" &&
		(typeof element.effectType !== "string" || element.effectType.length === 0)
	) {
		issues.push(`${path}.effectType must be a non-empty string.`);
	}
}

function validateTimelineViewState({
	issues,
	value,
}: {
	issues: string[];
	value: unknown;
}): void {
	if (!isRecord(value)) {
		issues.push('"timelineViewState" must be an object when present.');
		return;
	}
	if (typeof value.zoomLevel !== "number") {
		issues.push('"timelineViewState.zoomLevel" must be a number.');
	}
	if (typeof value.scrollLeft !== "number") {
		issues.push('"timelineViewState.scrollLeft" must be a number.');
	}
	requireInteger({
		issues,
		value: value.playheadTime,
		path: "timelineViewState.playheadTime",
	});
}

function requireInteger({
	issues,
	value,
	path,
}: {
	issues: string[];
	value: unknown;
	path: string;
}): void {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		issues.push(`"${path}" must be an integer number of ticks.`);
	}
}

function requireIsoDate({
	issues,
	value,
	path,
}: {
	issues: string[];
	value: unknown;
	path: string;
}): void {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		issues.push(`"${path}" must be an ISO date string.`);
	}
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
