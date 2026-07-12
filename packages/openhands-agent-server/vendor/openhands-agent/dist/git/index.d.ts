export declare const GIT_EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export declare const MAX_FILE_SIZE_FOR_GIT_DIFF: number;
export declare enum GitChangeStatus {
    MOVED = "MOVED",
    ADDED = "ADDED",
    DELETED = "DELETED",
    UPDATED = "UPDATED"
}
export interface GitChange {
    readonly status: `${GitChangeStatus}`;
    readonly path: string;
}
export interface GitDiff {
    readonly modified: string | null;
    readonly original: string | null;
}
export declare class GitError extends Error {
}
export declare class GitRepositoryError extends GitError {
    readonly command: string | null;
    readonly exitCode: number | null;
    constructor(message: string, command?: string | null, exitCode?: number | null);
}
export declare class GitCommandError extends GitError {
    readonly command: readonly string[];
    readonly exitCode: number;
    readonly stderr: string;
    constructor(message: string, command: readonly string[], exitCode: number, stderr?: string);
}
export declare class GitPathError extends GitError {
}
export declare function runGitCommand(args: readonly string[], options?: {
    readonly cwd?: string | null;
    readonly timeoutSeconds?: number;
}): Promise<string>;
export declare function validateGitRepository(repoDir: string): Promise<string>;
export declare function getValidRef(repoDir: string, override?: string | null): Promise<string>;
export declare function getChangesInRepo(repoDir: string, ref?: string | null): Promise<GitChange[]>;
export declare function getClosestGitRepo(path: string): Promise<string | null>;
export declare function getGitDiff(filePath: string, ref?: string | null): Promise<GitDiff>;
export declare function isGitUrl(source: string): boolean;
export declare function normalizeGitUrl(url: string): string;
export declare function extractRepoName(source: string): string;
