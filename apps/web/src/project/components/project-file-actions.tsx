"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { ProjectFileError } from "@/project/file/import-export";
import {
	downloadProjectFile,
	persistImportedProjectFile,
	readExportableProject,
} from "@/project/file/persist";

export function useProjectFileActions() {
	const editor = useEditor();
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);

	const exportProject = async () => {
		try {
			const project = await readExportableProject({ editor });
			downloadProjectFile({ project });
		} catch (error) {
			toast.error("Could not export project file", {
				description: error instanceof Error ? error.message : "Please try again",
			});
		}
	};

	const openImportPicker = () => {
		inputRef.current?.click();
	};

	const importFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			const text = await file.text();
			const { projectId, warnings } = await persistImportedProjectFile({ text });
			await editor.project.loadAllProjects();
			if (warnings.length > 0) {
				toast.warning("Project imported with warnings", {
					description: warnings.join("\n"),
				});
			} else {
				toast.success("Project imported");
			}
			router.push(`/editor/${projectId}`);
		} catch (error) {
			const description =
				error instanceof ProjectFileError
					? error.message
					: error instanceof Error
						? error.message
						: "Please try again";
			toast.error("Could not import project file", { description });
		} finally {
			if (inputRef.current) {
				inputRef.current.value = "";
			}
		}
	};

	return { inputRef, exportProject, openImportPicker, importFile };
}

export function ProjectFileInput({
	inputRef,
	onFile,
}: {
	inputRef: React.RefObject<HTMLInputElement | null>;
	onFile: (file: File | undefined) => void;
}) {
	return (
		<input
			ref={inputRef}
			type="file"
			accept="application/json,.json,.opencut.json"
			className="hidden"
			aria-label="Import project file"
			onChange={(event) => {
				onFile(event.target.files?.[0]);
			}}
		/>
	);
}

export function ImportProjectButton() {
	const { inputRef, openImportPicker, importFile } = useProjectFileActions();

	return (
		<>
			<Button
				variant="outline"
				size="lg"
				className="px-4 md:px-5"
				onClick={openImportPicker}
			>
				<Upload />
				<span className="hidden sm:inline">Import</span>
			</Button>
			<ProjectFileInput inputRef={inputRef} onFile={(file) => void importFile(file)} />
		</>
	);
}

export const projectFileMenuIcons = {
	export: <Download />,
	import: <Upload />,
};
