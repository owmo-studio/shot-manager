import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { VideoMetadata } from "../shared/shots";
import type { EmbeddedContainer } from "./embedded";

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false });
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string | null => typeof value === "string" && value.trim() && !["unknown", "unspecified", "n/a"].includes(value.toLowerCase()) ? value.trim() : null;
const number = (value: unknown): number | null => (typeof value === "number" || typeof value === "string") && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

export function rational(value: unknown): number | null {
    const match = typeof value === "string" ? /^(\d+)\/(\d+)$/.exec(value) : null;
    return match && Number(match[2]) > 0 && Number(match[1]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

export function sonyMetadata(container: EmbeddedContainer) {
    for (const xml of container.xml) {
        if (!xml.includes("NonRealTimeMeta")) continue;
        if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) {
            container.warnings.push("Embedded Sony XML is invalid; available stream metadata is shown.");
            continue;
        }
        try {
            const data = object(object(parser.parse(xml)).NonRealTimeMeta);
            const device = object(data.Device);
            if (device["@_manufacturer"] !== "Sony") continue;
            const video = object(object(data.VideoFormat).VideoFrame);
            const items = new Map<string, unknown>();
            for (const group of list(object(data.AcquisitionRecord).Group)) {
                for (const item of list(object(group).Item)) {
                    const row = object(item);
                    if (typeof row["@_name"] === "string") items.set(row["@_name"], row["@_value"]);
                }
            }
            return {
                model: text(device["@_modelName"]), timestamp: text(object(data.CreationDate)["@_value"]),
                gamma: text(items.get("CaptureGammaEquation")), primaries: text(items.get("CaptureColorPrimaries")),
                matrix: text(items.get("CodingEquations")), captureFps: text(video["@_captureFps"]),
                proxy: /proxy/i.test(String(video["@_videoCodec"] ?? "")),
            };
        } catch { container.warnings.push("Embedded Sony XML could not be interpreted."); }
    }
    return null;
}

export function normalizeVideoMetadata(info: Record<string, unknown> | undefined, embedded: EmbeddedContainer, sony = sonyMetadata(embedded)) {
    const data = object(info);
    const streams = list(data.streams).map(object);
    const video = streams.find((stream) => stream.codec_type === "video" && object(stream.disposition).attached_pic !== 1) ?? {};
    const tags = { ...object(video.tags), ...object(object(data.format).tags) };
    const trackId = typeof video.id === "string" ? Number(video.id) : null;
    const track = embedded.tracks.find((item) => item.handler === "vide" && item.id === trackId) ?? embedded.tracks.find((item) => item.handler === "vide");
    const logs = track?.logProfiles ?? [];
    const appleLog = logs.includes("com.apple.rec2020.apple-log");
    const appLog = text(tags["com.apple.quicktime.colorSpace"]) === "apple_log";
    const rawModel = sony?.model ?? text(tags["com.apple.quicktime.model"]);
    const manufacturer = sony ? "Sony" : text(tags["com.apple.quicktime.make"]) ?? text(tags["com.apple.proapps.manufacturer"]) ?? (rawModel?.startsWith("Apple iPhone") ? "Apple" : null);
    const model = rawModel?.replace(/^Apple (iPhone)/, "$1").replace(/^(iPhone .*?) \d+(?:\.\d+)?mm$/, "$1") ?? null;
    const pixelFormat = text(video.pix_fmt);
    const bitDepth = number(video.bits_per_raw_sample) || (pixelFormat?.match(/p(\d+)(?:le|be)?$/)?.[1] ? Number(pixelFormat.match(/p(\d+)(?:le|be)?$/)![1]) : pixelFormat?.startsWith("p010") ? 10 : pixelFormat && /^(yuvj?\d+p|nv12|nv21|rgb24|bgr24|rgba|bgra|gray)$/.test(pixelFormat) ? 8 : null);
    const chroma = pixelFormat?.includes("420") || pixelFormat?.startsWith("p010") || pixelFormat === "nv12" ? "4:2:0" : pixelFormat?.includes("422") ? "4:2:2" : pixelFormat?.includes("444") ? "4:4:4" : null;
    const primaries = sony?.primaries ?? (appleLog ? "bt2020" : text(video.color_primaries));
    const transfer = sony?.gamma ?? (appleLog || appLog ? "apple-log" : text(video.color_transfer));
    const matrix = sony?.matrix ?? text(video.color_space);
    let colorLabel: string | null = null;
    if (transfer === "apple-log") colorLabel = appleLog ? "Apple Log / Rec.2020" : "Apple Log (app-declared)";
    else if (transfer?.startsWith("s-log3")) colorLabel = `S-Log3${primaries === "s-gamut3-cine" ? " / S-Gamut3.Cine" : primaries ? ` / ${primaries}` : " (gamut unknown)"}`;
    else if (["bt709", "rec709"].includes(transfer ?? "") && ["bt709", "rec709"].includes(primaries ?? "")) colorLabel = "Rec.709";
    else if (transfer === "arib-std-b67") colorLabel = `HLG${primaries === "bt2020" ? " / Rec.2020" : ""}`;
    else if (transfer === "smpte2084") colorLabel = `PQ${primaries === "bt2020" ? " / Rec.2020" : ""}`;
    else if (primaries || transfer) colorLabel = `${primaries === "bt2020" ? "Rec.2020" : primaries ?? "Gamut unknown"} / ${transfer ?? "transfer unknown"}`;
    const same = (a: string, b: string) => a.replace(/^rec/, "bt") === b.replace(/^rec/, "bt");
    const conflicts: string[] = [];
    if (sony?.gamma && text(video.color_transfer) && !same(sony.gamma, String(video.color_transfer))) conflicts.push("Embedded capture gamma differs from the video stream declaration.");
    if (sony?.primaries && text(video.color_primaries) && !same(sony.primaries, String(video.color_primaries))) conflicts.push("Embedded capture gamut differs from the video stream declaration.");
    if (appleLog && text(video.color_transfer) && text(video.color_transfer) !== "apple-log") conflicts.push("Apple Log declaration differs from the standard stream transfer tag.");
    if (appleLog && text(video.color_primaries) && video.color_primaries !== "bt2020") conflicts.push("Apple Log declaration differs from the standard stream primaries tag.");
    const rotationData = list(video.side_data_list).map(object).find((item) => item.side_data_type === "Display Matrix");
    const rotation = number(rotationData?.rotation) ?? number(object(video.tags).rotate) ?? 0;
    const width = number(video.width), height = number(video.height);
    const quarterTurn = Math.abs(rotation) % 180 === 90;
    const declaredFps = number(tags["com.blackmagic-design.sensorFPS"]) ?? (sony?.captureFps ? number(sony.captureFps.replace(/[pi]$/, "")) : null);
    const metadata: VideoMetadata = {
        device: { manufacturer, model, software: text(tags["com.apple.quicktime.software"]), evidence: sony ? "Embedded Sony XML" : rawModel || manufacturer ? "Embedded file tags" : null },
        codec: { name: text(video.codec_name), profile: text(video.profile), bitDepth, chroma },
        color: {
            label: colorLabel, primaries, transfer, matrix, range: text(video.color_range),
            evidence: sony?.gamma || sony?.primaries ? "Embedded Sony XML" : appleLog ? "Apple Log sample-entry declaration" : appLog ? "App-specific metadata" : colorLabel ? "Video stream tags" : null,
            confidence: colorLabel ? "declared" : "unknown", conflicts,
        },
        resolution: { width, height, rotation, displayWidth: quarterTurn ? height : width, displayHeight: quarterTurn ? width : height },
        frameRate: {
            nominal: declaredFps ?? rational(video.r_frame_rate), average: rational(video.avg_frame_rate), rational: text(video.avg_frame_rate),
            mode: track?.timing ? track.timing.maximumDelta === track.timing.minimumDelta ? "constant" : "variable" : "unknown",
            evidence: track?.timing ? "Embedded sample timing table" : null,
        },
    };
    const timestampCandidates = [
        { value: sony?.timestamp, source: "Embedded Sony recording date", capture: true },
        { value: text(tags["com.apple.quicktime.creationdate"]), source: "QuickTime recording date", capture: true },
        { value: text(tags["com.blackmagic-design.camera.dateRecorded"]), source: "Blackmagic recording date", capture: true },
        { value: text(tags.creation_time), source: "Container creation time (capture time unconfirmed)", capture: false },
    ];
    const timestamp = timestampCandidates.find((candidate) => candidate.value && /(?:Z|[+-]\d{2}:?\d{2})$/.test(candidate.value) && Number.isFinite(Date.parse(candidate.value)));
    const recordingDates = timestampCandidates.filter((candidate) => candidate.capture && candidate.value && /(?:Z|[+-]\d{2}:?\d{2})$/.test(candidate.value) && Number.isFinite(Date.parse(candidate.value)));
    const dateConflict = timestamp?.capture && recordingDates.some((candidate) => Math.abs(Date.parse(candidate.value!) - Date.parse(timestamp.value!)) > 1000);
    if (dateConflict) embedded.warnings.push("Embedded recording dates disagree; the selected date's source is shown and raw values are retained.");
    if (timestampCandidates.some((candidate) => candidate.capture && candidate.value && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(candidate.value))) embedded.warnings.push("A recording date has no timezone; it was not assumed to use the computer's timezone.");
    return { metadata, sony, timestamp: timestamp ? { ...timestamp, conflict: !!dateConflict } : undefined, hasVideo: !!video.codec_type };
}
