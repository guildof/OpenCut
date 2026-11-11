import type { TProject } from "@/project/types";
import type { Bookmark, SceneTracks } from "@/timeline";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import { roundMediaTime } from "@/wasm";
import type { SerializedProject, SerializedScene } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			if (!isRecord(item) || typeof item.time !== "number") {
				return null;
			}
			return {
				time: roundMediaTime({ time: item.time }),
				...(typeof item.note === "string" && { note: item.note }),
				...(typeof item.color === "string" && { color: item.color }),
				...(typeof item.duration === "number" && {
					duration: roundMediaTime({ time: item.duration }),
				}),
			};
		})
		.filter((bookmark): bookmark is Bookmark => bookmark !== null);
}

function stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
	return {
		...tracks,
		audio: tracks.audio.map((track) => ({
			...track,
			elements: track.elements.map((element) => {
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}),
		})),
	};
}

export function serializeProject({
	project,
}: {
	project: TProject;
}): SerializedProject {
	const duration =
		project.metadata.duration ??
		getProjectDurationFromScenes({ scenes: project.scenes });
	const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks: stripAudioBuffers({ tracks: scene.tracks }),
		bookmarks: scene.bookmarks,
		createdAt: scene.createdAt.toISOString(),
		updatedAt: scene.updatedAt.toISOString(),
	}));

	return {
		metadata: {
			id: project.metadata.id,
			name: project.metadata.name,
			thumbnail: project.metadata.thumbnail,
			duration,
			createdAt: project.metadata.createdAt.toISOString(),
			updatedAt: project.metadata.updatedAt.toISOString(),
		},
		scenes: serializedScenes,
		currentSceneId: project.currentSceneId,
		settings: project.settings,
		version: project.version,
		timelineViewState: project.timelineViewState,
	};
}

export function deserializeProject({
	serializedProject,
}: {
	serializedProject: SerializedProject;
}): TProject {
	const scenes =
		serializedProject.scenes?.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: scene.tracks,
			bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})) ?? [];

	return {
		metadata: {
			id: serializedProject.metadata.id,
			name: serializedProject.metadata.name,
			thumbnail: serializedProject.metadata.thumbnail,
			duration: roundMediaTime({
				time:
					serializedProject.metadata.duration ??
					getProjectDurationFromScenes({ scenes }),
			}),
			createdAt: new Date(serializedProject.metadata.createdAt),
			updatedAt: new Date(serializedProject.metadata.updatedAt),
		},
		scenes,
		currentSceneId: serializedProject.currentSceneId || "",
		settings: serializedProject.settings,
		version: serializedProject.version,
		timelineViewState: serializedProject.timelineViewState,
	};
}
