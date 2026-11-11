import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import type { TProject } from "@/project/types";
import { roundMediaTime } from "@/wasm";
import {
	ProjectFileError,
	importProjectDocument,
	projectFileJson,
} from "../import-export";

const EXAMPLE_PATH = new URL(
	"../../../../../../docs/examples/minimal-project.json",
	import.meta.url,
);

const ticks = ({ value }: { value: number }) => roundMediaTime({ time: value });

function textProject(): TProject {
	const createdAt = new Date("2026-01-01T00:00:00.000Z");
	return {
		metadata: {
			id: "project-roundtrip",
			name: "Round trip",
			duration: ticks({ value: 600000 }),
			createdAt,
			updatedAt: createdAt,
		},
		currentSceneId: "scene-main",
		version: CURRENT_PROJECT_VERSION,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				bookmarks: [],
				createdAt,
				updatedAt: createdAt,
				tracks: {
					overlay: [
						{
							id: "track-title",
							name: "Title",
							type: "text",
							hidden: false,
							elements: [
								{
									id: "clip-title",
									type: "text",
									name: "Title",
									duration: ticks({ value: 600000 }),
									startTime: ticks({ value: 0 }),
									trimStart: ticks({ value: 0 }),
									trimEnd: ticks({ value: 0 }),
									params: { content: "Hello" },
								},
							],
						},
					],
					main: {
						id: "track-main",
						name: "Main Track",
						type: "video",
						muted: false,
						hidden: false,
						elements: [
							{
								id: "clip-still",
								type: "image",
								name: "Still",
								mediaId: "media-still",
								duration: ticks({ value: 600000 }),
								startTime: ticks({ value: 0 }),
								trimStart: ticks({ value: 0 }),
								trimEnd: ticks({ value: 0 }),
								params: {},
							},
						],
					},
					audio: [],
				},
			},
		],
	};
}

describe("project file import/export", () => {
	test("round-trips a project file without changing it", async () => {
		const project = textProject();
		const file = JSON.parse(projectFileJson({ project })) as unknown;
		const imported = await importProjectDocument({
			text: JSON.stringify(file),
			availableMediaIds: ["media-still"],
		});

		expect(imported.warnings).toEqual([]);
		expect(JSON.parse(projectFileJson({ project: imported.project }))).toEqual(
			file,
		);
	});

	test("warns when a referenced media file is not available", async () => {
		const imported = await importProjectDocument({
			text: projectFileJson({ project: textProject() }),
		});

		expect(imported.warnings.join("\n")).toContain("media-still");
		expect(imported.warnings.join("\n")).toContain("does not include media bytes");
	});

	test("rejects a file that is not a project", async () => {
		await expect(importProjectDocument({ text: "not json" })).rejects.toThrow(
			ProjectFileError,
		);
		await expect(
			importProjectDocument({ text: JSON.stringify(["nope"]) }),
		).rejects.toThrow("JSON object");
		await expect(
			importProjectDocument({ text: JSON.stringify({ name: "missing id" }) }),
		).rejects.toThrow("metadata.id");
		await expect(
			importProjectDocument({
				text: JSON.stringify({ metadata: { id: "p", name: "P" }, version: "31" }),
			}),
		).rejects.toThrow('"version" must be an integer.');
		await expect(
			importProjectDocument({
				text: JSON.stringify({
					metadata: { id: "p", name: "P" },
					version: CURRENT_PROJECT_VERSION + 1,
				}),
			}),
		).rejects.toThrow("supports up to version");
	});

	test("migrates a version 30 file through the storage migration runner", async () => {
		const createdAt = "2026-01-01T00:00:00.000Z";
		const legacy = {
			version: 30,
			metadata: {
				id: "project-v30",
				name: "Legacy",
				duration: 0,
				createdAt,
				updatedAt: createdAt,
			},
			currentSceneId: "scene-main",
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000000" },
			},
			scenes: [
				{
					id: "scene-main",
					name: "Main scene",
					isMain: true,
					createdAt,
					updatedAt: createdAt,
					bookmarks: [],
					tracks: {
						overlay: [],
						audio: [],
						main: {
							id: "track-main",
							name: "Main Track",
							type: "video",
							muted: false,
							hidden: false,
							elements: [
								{
									id: "clip-still",
									type: "image",
									name: "Still",
									mediaId: "media-still",
									duration: 0,
									startTime: 0,
									trimStart: 0,
									trimEnd: 0,
									params: {},
									masks: [{ id: "mask-1", type: "custom", params: { feather: 0 } }],
								},
							],
						},
					},
				},
			],
		};

		const imported = await importProjectDocument({
			text: JSON.stringify(legacy),
			availableMediaIds: ["media-still"],
		});

		expect(imported.project.version).toBe(31);
		expect(imported.warnings).toEqual([]);
		const mask = imported.project.scenes[0]?.tracks.main.elements[0];
		expect(mask && "masks" in mask ? mask.masks?.[0]?.type : null).toBe(
			"freeform",
		);
	});

	test("imports the documented minimal example", async () => {
		const text = readFileSync(EXAMPLE_PATH, "utf8");
		const imported = await importProjectDocument({ text });
		const clip = imported.project.scenes[0]?.tracks.overlay[0]?.elements[0];

		expect(imported.warnings).toEqual([]);
		expect(imported.project.version).toBe(31);
		expect(imported.project.metadata.name).toBe("Hello");
		expect(clip?.type).toBe("text");
		expect(clip && "params" in clip ? clip.params.content : null).toBe("Hello");
	});
});
