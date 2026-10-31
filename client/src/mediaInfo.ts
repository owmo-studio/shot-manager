export interface MetadataRow {
    key: string;
    label: string;
    value: string;
}

export interface MetadataGroup {
    title: string;
    rows: MetadataRow[];
}

const labels: Record<string, string> = {
    format_name: "Container format",
    format_long_name: "Container description",
    duration: "Duration (seconds)",
    size: "File size (bytes)",
    bit_rate: "Bit rate (bits per second)",
    codec_type: "Track type",
    codec_name: "Codec",
    codec_long_name: "Codec description",
    profile: "Codec profile",
    width: "Width (pixels)",
    height: "Height (pixels)",
    avg_frame_rate: "Average frame rate",
    r_frame_rate: "Nominal frame rate",
    pix_fmt: "Pixel format",
    color_space: "Color matrix",
    color_transfer: "Transfer characteristic (gamma)",
    color_primaries: "Color primaries",
    sample_rate: "Audio sample rate (Hz)",
    channels: "Audio channel count",
    channel_layout: "Audio channel layout",
    creation_time: "Creation time",
    language: "Language",
    handler_name: "Track name",
    encoder: "Encoder",
    vendor_id: "Encoder vendor",
    major_brand: "Primary container brand",
    minor_version: "Container revision",
    compatible_brands: "Compatible container brands",
    timecode: "Timecode",
    rotate: "Rotation (degrees)",
};

function readableLabel(key: string): string {
    return labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function readableValue(key: string, value: unknown): string {
    const raw = String(value ?? "—");
    if (["avg_frame_rate", "r_frame_rate"].includes(key) && typeof value === "string") {
        const match = /^(\d+)\/(\d+)$/.exec(value);
        if (match && Number(match[2]) > 0) return `${(Number(match[1]) / Number(match[2])).toLocaleString(undefined, { maximumFractionDigits: 3 })} fps (${raw})`;
    }
    if (key === "codec_name") {
        const codecs: Record<string, string> = { h264: "H.264 / AVC", hevc: "H.265 / HEVC", prores: "Apple ProRes", aac: "AAC audio", pcm_s16le: "16-bit PCM audio (little-endian)", pcm_s24le: "24-bit PCM audio (little-endian)" };
        if (codecs[raw]) return `${codecs[raw]} (${raw})`;
    }
    return raw;
}

export function readableMediaInfo(info: Record<string, unknown>): MetadataGroup[] {
    const groups: MetadataGroup[] = [];
    function addGroup(title: string, value: unknown, prefix: string) {
        const rows: MetadataRow[] = [];
        function visit(item: unknown, path: string, label: string, key: string, depth: number) {
            if (rows.length >= 200 || depth > 6) return;
            if (item !== null && typeof item === "object") {
                for (const [childKey, child] of Object.entries(item)) {
                    const childLabel = readableLabel(childKey);
                    visit(child, `${path}.${childKey}`, childKey === "tags" ? "" : label ? `${label} · ${childLabel}` : childLabel, childKey, depth + 1);
                }
            } else rows.push({ key: path, label, value: readableValue(key, item) });
        }
        visit(value, prefix, "", "", 0);
        if (rows.length) groups.push({ title, rows });
    }
    if (info.format) addGroup("Container", info.format, "format");
    if (Array.isArray(info.streams)) {
        info.streams.forEach((stream: unknown, index) => {
            const type = stream && typeof stream === "object" && "codec_type" in stream ? readableLabel(String(stream.codec_type)) : "Media";
            addGroup(`${type} track ${index + 1}`, stream, `streams.${index}`);
        });
    }
    for (const [key, value] of Object.entries(info)) {
        if (key !== "format" && key !== "streams") addGroup(readableLabel(key), value, key);
    }
    return groups;
}

export function sourceFilePath(root: string | undefined, relativePath: string): string {
    return root ? `${root.replace(/\/+$/, "")}/${relativePath}` : relativePath;
}
