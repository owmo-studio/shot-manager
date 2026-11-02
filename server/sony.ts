import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export async function findSonyLayout(sourcePath: string) {
    for (const root of [join(sourcePath, "PRIVATE", "M4ROOT"), join(sourcePath, "M4ROOT"), sourcePath]) {
        const clips = join(root, "CLIP");
        try {
            const resolved = await realpath(clips);
            const withinSource = relative(sourcePath, resolved);
            if (withinSource.startsWith("..") || isAbsolute(withinSource)) continue;
            if ((await stat(resolved)).isDirectory()) return { root, clips: resolved };
        } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
    }
    if (basename(sourcePath) === "CLIP" && basename(dirname(sourcePath)) === "M4ROOT") {
        return { root: sourcePath, clips: sourcePath };
    }
    return null;
}
