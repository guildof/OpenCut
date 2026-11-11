import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import { storageService } from "@/services/storage/service";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import { generateUUID } from "@/utils/id";
import { importProjectDocument, projectFileJson, projectFileName } from "./import-export";

export async function readExportableProject({
	editor,
}: {
	editor: EditorCore;
}): Promise<TProject> {
	await editor.project.saveCurrentProject();
	const active = editor.project.getActive();
	const scenes = editor.scenes.getScenes();
	const duration = getProjectDurationFromScenes({ scenes });

	return {
		...active,
		scenes,
		metadata: {
			...active.metadata,
			duration: duration > 0 ? duration : active.metadata.duration,
		},
	};
}

export function downloadProjectFile({ project }: { project: TProject }): void {
	const json = projectFileJson({ project });
	const blob = new Blob([json], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = projectFileName({ name: project.metadata.name });
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export async function persistImportedProjectFile({
	text,
}: {
	text: string;
}): Promise<{ projectId: string; warnings: string[] }> {
	const firstPass = await importProjectDocument({ text });
	const existing = await storageService.loadProject({
		id: firstPass.project.metadata.id,
	});

	if (existing) {
		const id = generateUUID();
		const name = `${firstPass.project.metadata.name} copy`;
		const project: TProject = {
			...firstPass.project,
			metadata: {
				...firstPass.project.metadata,
				id,
				name,
			},
		};
		await storageService.saveProject({ project });
		return {
			projectId: id,
			warnings: [
				`A project with this id already exists. Imported as a copy named "${name}".`,
				...firstPass.warnings,
			],
		};
	}

	const mediaIds = await storageService.listMediaAssetIds({
		projectId: firstPass.project.metadata.id,
	});
	const imported = await importProjectDocument({
		text,
		availableMediaIds: mediaIds,
	});
	await storageService.saveProject({ project: imported.project });
	return {
		projectId: imported.project.metadata.id,
		warnings: imported.warnings,
	};
}
