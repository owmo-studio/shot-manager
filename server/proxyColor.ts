// The ProRes MOV uses video-range YCbCr. Range and (for RGB input) matrix changes
// describe its storage; the source transfer function and primaries describe the grade.
export interface StreamColor {
    pix_fmt?: string; color_range?: string; color_space?: string; color_transfer?: string; color_primaries?: string;
}

type CameraColor = { gamma?: string | null; primaries?: string | null; matrix?: string | null };

export function proxyColor(video: StreamColor, sony: CameraColor | null, appleLog: boolean) {
    const captureTags: Record<string, string> = {};
    if (sony?.gamma) captureTags.CaptureGammaEquation = sony.gamma;
    if (sony?.primaries) captureTags.CaptureColorPrimaries = sony.primaries;
    if (sony?.matrix) captureTags.CodingEquations = sony.matrix;
    if (appleLog) captureTags['com.apple.quicktime.colorSpace'] = 'apple_log';

    // Sony XML can declare camera-specific curves/gamuts with no CICP code.
    // Retain their names in MOV metadata and clear any conflicting standard tag.
    const standard = (capture: string | null | undefined, stream: string | undefined, supported: string[]) => {
        if (!capture) return stream;
        const value = capture.toLowerCase().replace(/^rec/, 'bt');
        return value === stream || supported.includes(value) ? value : undefined;
    };
    const primaries = appleLog ? 'bt2020' : standard(sony?.primaries, video.color_primaries, ['bt709', 'bt2020']);
    const transfer = appleLog ? undefined : standard(sony?.gamma, video.color_transfer, ['bt709', 'linear', 'arib-std-b67', 'smpte2084']);
    const rgb = video.color_space === 'gbr' || /^(?:gbr|[0ax]?rgb|[0ax]?bgr|x2rgb|x2bgr|pal8)/.test(video.pix_fmt ?? '');
    const matrix = rgb ? (primaries === 'bt2020' ? 'bt2020nc' : 'bt709') :
        standard(sony?.matrix, video.color_space, ['bt709', 'bt2020nc', 'bt2020c']);
    const inputDeclarations: string[] = [];
    // Correct the *interpretation* of the source before scaling. Asking the scaler
    // to convert between a conflicting stream tag and the camera declaration would bake a transform.
    if (primaries !== video.color_primaries) inputDeclarations.push('color_primaries=' + (primaries ?? 'unknown'));
    if (transfer !== video.color_transfer) inputDeclarations.push('color_trc=' + (transfer ?? 'unknown'));
    if (!rgb && matrix !== video.color_space) inputDeclarations.push('colorspace=' + (matrix ?? 'unknown'));
    return { primaries, transfer, matrix, range: video.color_range, rgb, captureTags, inputDeclarations };
}
export type ProxyColor = ReturnType<typeof proxyColor>;

export function proxyColorFilters(color: ProxyColor) {
    const filters: string[] = [];
    if (color.inputDeclarations.length) filters.push('setparams=' + color.inputDeclarations.join(':'));
    let scale = "scale=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:out_range=tv";
    if (color.range === 'pc' || color.range === 'tv') scale += ':in_range=' + color.range;
    if (color.rgb) scale += ':out_color_matrix=' + color.matrix;
    filters.push(scale, 'format=yuv422p10le');
    return filters;
}

export function verifyProxyColor(color: ProxyColor, video: StreamColor, tags?: Record<string, string>) {
    for (const [name, expected, actual] of [
        ['levels', 'tv', video.color_range],
        ['transfer function', color.transfer, video.color_transfer],
        ['primaries', color.primaries, video.color_primaries],
        ['matrix', color.matrix, video.color_space],
    ]) {
        if ((expected ?? 'unknown') !== (actual ?? 'unknown')) {
            throw new Error(`Proxy color verification failed for ${name} (expected ${expected ?? 'unknown'}, found ${actual ?? 'unknown'}).`);
        }
    }
    for (const [key, value] of Object.entries(color.captureTags)) {
        if (tags?.[key] !== value) throw new Error(`Proxy lost the source color declaration ${key}.`);
    }
}
