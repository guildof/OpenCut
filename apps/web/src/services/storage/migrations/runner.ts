import {
	IndexedDBAdapter,
	deleteDatabase,
} from "@/services/storage/indexeddb-adapter";
import type { StorageMigration } from "./base";
import type { ProjectRecord } from "./transformers/types";
import { getProjectId, isRecord } from "./transformers/utils";

export interface StorageMigrationResult {
	migratedCount: number;
}

export interface MigrationProgress {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

let hasCleanedUpMetaDb = false;

const MIN_MIGRATION_DISPLAY_MS = 1000;

export async function runStorageMigrations({
	migrations,
	onProgress,
}: {
	migrations: StorageMigration[];
	onProgress?: (progress: MigrationProgress) => void;
}): Promise<StorageMigrationResult> {
	// One-time cleanup: delete the old global version database
	if (!hasCleanedUpMetaDb) {
		try {
			await deleteDatabase({ dbName: "video-editor-meta" });
		} catch {
			// Ignore errors - DB might not exist
		}
		hasCleanedUpMetaDb = true;
	}

	const projectsAdapter = new IndexedDBAdapter<ProjectRecord>({
		dbName: "video-editor-projects",
		storeName: "projects",
		version: 1,
	});

	const projects = await projectsAdapter.getAll();

	const orderedMigrations = [...migrations].sort((a, b) => a.from - b.from);
	let migratedCount = 0;
	let migrationStartTime: number | null = null;

	for (const project of projects) {
		if (typeof project !== "object" || project === null) {
			continue;
		}

		const projectRecord = project as ProjectRecord;
		const projectId = getProjectId({ project: projectRecord });
		if (!projectId) {
			continue;
		}

		const currentVersion = getProjectVersion({ project: projectRecord });
		const targetVersion = orderedMigrations.at(-1)?.to ?? currentVersion;

		if (currentVersion >= targetVersion) {
			continue;
		}

		// Track when we first showed the migration dialog
		if (migrationStartTime === null) {
			migrationStartTime = Date.now();
		}

		const projectName = getProjectName({ project: projectRecord });
		onProgress?.({
			isMigrating: true,
			fromVersion: currentVersion,
			toVersion: targetVersion,
			projectName,
		});

		const migrated = await migrateProjectRecord({
			project: projectRecord,
			migrations: orderedMigrations,
			onStep: async ({ project: next }) => {
				await projectsAdapter.set({ key: projectId, value: next });
			},
		});
		migratedCount += migrated.stepsApplied;
	}

	// Ensure dialog is visible for minimum time so users can see it
	if (migrationStartTime !== null) {
		const elapsed = Date.now() - migrationStartTime;
		if (elapsed < MIN_MIGRATION_DISPLAY_MS) {
			await new Promise((resolve) =>
				setTimeout(resolve, MIN_MIGRATION_DISPLAY_MS - elapsed),
			);
		}
	}

	onProgress?.({
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	});

	return { migratedCount };
}

export interface MigrateProjectRecordResult {
	project: ProjectRecord;
	stepsApplied: number;
	/** Version where a migration was skipped or the chain stopped short of the newest migration. */
	stoppedAt: number | null;
}

/**
 * Applies the same ordered migration chain as {@link runStorageMigrations},
 * to a single in-memory project. IndexedDB persistence is optional via `onStep`,
 * which the storage runner uses after each successful step.
 */
export async function migrateProjectRecord({
	project,
	migrations,
	onStep,
}: {
	project: ProjectRecord;
	migrations: StorageMigration[];
	onStep?: (args: { project: ProjectRecord }) => Promise<void>;
}): Promise<MigrateProjectRecordResult> {
	const projectId = getProjectId({ project });
	if (!projectId) {
		return { project, stepsApplied: 0, stoppedAt: null };
	}

	const orderedMigrations = [...migrations].sort((a, b) => a.from - b.from);
	let currentVersion = getProjectVersion({ project });
	const targetVersion = orderedMigrations.at(-1)?.to ?? currentVersion;
	if (currentVersion >= targetVersion) {
		return { project, stepsApplied: 0, stoppedAt: null };
	}

	let projectRecord = project;
	let stepsApplied = 0;

	for (const migration of orderedMigrations) {
		if (migration.from !== currentVersion) {
			continue;
		}

		const result = await migration.run({
			projectId,
			project: projectRecord,
		});

		if (result.skipped) {
			return { project: projectRecord, stepsApplied, stoppedAt: currentVersion };
		}

		projectRecord = result.project;
		currentVersion = migration.to;
		stepsApplied++;
		if (onStep) {
			await onStep({ project: projectRecord });
		}
	}

	return {
		project: projectRecord,
		stepsApplied,
		stoppedAt: currentVersion < targetVersion ? currentVersion : null,
	};
}

export function getProjectVersion({ project }: { project: ProjectRecord }): number {
	const versionValue = project.version;

	// v2 and up - has explicit version field
	if (typeof versionValue === "number") {
		return versionValue;
	}

	// v1 - has scenes array
	const scenesValue = project.scenes;
	if (Array.isArray(scenesValue) && scenesValue.length > 0) {
		return 1;
	}

	// v0 - no scenes
	return 0;
}

function getProjectName({
	project,
}: {
	project: ProjectRecord;
}): string | null {
	const metadata = project.metadata;
	if (isRecord(metadata) && typeof metadata.name === "string") {
		return metadata.name;
	}

	// v0 had name directly on project
	if (typeof project.name === "string") {
		return project.name;
	}

	return null;
}
