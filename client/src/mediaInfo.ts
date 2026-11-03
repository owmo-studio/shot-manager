import type { VideoMetadata } from "../../shared/shots";

export function sourceFilePath(root: string | undefined, relativePath: string): string {
    return root ? root.replace(/\/+$/, "") + "/" + relativePath : relativePath;
}

export function deviceLabel(device: VideoMetadata["device"]): string | null {
    const models: Record<string, string> = { "ILME-FX30": "FX30", "ZV-E10M2": "ZV-E10 II" };
    return device.model ? models[device.model] ?? device.model : null;
}

export function primaryMetadataRows(metadata: VideoMetadata) {
    const { device, codec, color, resolution, frameRate } = metadata;
    const codecs: Record<string, string> = { h264: "H.264 / AVC", hevc: "H.265 / HEVC", prores: "Apple ProRes", av1: "AV1", vp9: "VP9" };
    const codecName = codec.name ? codecs[codec.name] ?? codec.name : null;
    const codecDetail = [codec.profile, codec.bitDepth ? codec.bitDepth + "-bit" : null, codec.chroma].filter(Boolean).join(" · ");
    const dimensions = resolution.displayWidth && resolution.displayHeight ? resolution.displayWidth + " × " + resolution.displayHeight : null;
    const resolutionDetail = resolution.rotation
        ? "Encoded " + resolution.width + " × " + resolution.height + " · " + resolution.rotation + "° rotation" : "";
    const fps = frameRate.nominal ?? frameRate.average;
    return [
        { label: "Device", value: deviceLabel(device) ?? "Unknown", detail: "" },
        { label: "Codec", value: codecName ?? "Unknown", detail: codecDetail },
        { label: "Color space", value: color.label ?? "Unknown", detail: "" },
        { label: "Resolution", value: dimensions ?? "Unknown", detail: resolutionDetail },
        { label: "Frame rate", value: fps !== null ? fps.toLocaleString(undefined, { maximumFractionDigits: 3 }) + " fps" : "Unknown", detail: "" },
    ];
}

export function durationRow(seconds: number | null, metadata: VideoMetadata) {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return { label: "Duration", value: "Unknown", detail: "" };
    const fps = metadata.frameRate.nominal ?? metadata.frameRate.average;
    if (fps === null || !Number.isFinite(fps) || fps < 1) {
        const timecode = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60]
            .map((value) => String(value).padStart(2, "0")).join(":");
        return { label: "Duration", value: timecode, detail: "" };
    }
    const timebase = Math.round(fps);
    const totalFrames = Math.round(seconds * fps);
    const frames = totalFrames % timebase;
    const totalSeconds = Math.floor(totalFrames / timebase);
    const timecode = [Math.floor(totalSeconds / 3600), Math.floor(totalSeconds / 60) % 60, totalSeconds % 60, frames]
        .map((value) => String(value).padStart(2, "0")).join(":");
    return { label: "Duration", value: timecode, detail: "" };
}
