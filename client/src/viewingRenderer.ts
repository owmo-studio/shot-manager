import type { VideoMetadata } from '../../shared/shots'
import type { ViewingLut } from '../../shared/viewing'

const vertex = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = vec2(p.x, 1. - p.y);
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`
const fragment = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 result;
uniform sampler2D image;
uniform sampler3D table;
uniform int grid;
uniform bool applyLut;
uniform bool correct2020;
vec3 lookup(vec3 rgb) {
  vec3 p = clamp(rgb, 0., 1.) * float(grid - 1);
  ivec3 a = ivec3(floor(p)), b = min(a + 1, ivec3(grid - 1));
  vec3 f = fract(p);
  return mix(mix(mix(texelFetch(table,a,0).rgb, texelFetch(table,ivec3(b.x,a.y,a.z),0).rgb,f.x),
                 mix(texelFetch(table,ivec3(a.x,b.y,a.z),0).rgb, texelFetch(table,ivec3(b.x,b.y,a.z),0).rgb,f.x), f.y),
             mix(mix(texelFetch(table,ivec3(a.x,a.y,b.z),0).rgb, texelFetch(table,ivec3(b.x,a.y,b.z),0).rgb,f.x),
                 mix(texelFetch(table,ivec3(a.x,b.y,b.z),0).rgb, texelFetch(table,b,0).rgb,f.x), f.y), f.z);
}
void main() {
  vec3 rgb = texture(image, uv).rgb;
  if (applyLut) {
    // Some platform decoders expose an unknown-transfer Apple Log sample as
    // BT.709 YUV. Undo that matrix and use the original's BT.2020-NCL matrix.
    // This operates on encoded values, not a linear-light gamut conversion.
    if (correct2020) {
      float y = dot(rgb, vec3(.2126,.7152,.0722));
      float cb = (rgb.b-y)/1.8556, cr = (rgb.r-y)/1.5748;
      rgb = vec3(y+1.4746*cr, y-.164553*cb-.571353*cr, y+1.8814*cb);
    }
    rgb = lookup(rgb);
  }
  result = vec4(clamp(rgb, 0., 1.), 1.);
}`

export class ViewingRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private videoTexture: WebGLTexture
  private lutTexture: WebGLTexture
  private shaders: WebGLShader[] = []
  private correct2020 = false

  constructor(private canvas: HTMLCanvasElement, private lut: ViewingLut | null, private metadata: VideoMetadata) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true })
    if (!gl) throw new Error('GPU viewing is unavailable.')
    this.gl = gl
    const program = gl.createProgram()!
    this.program = program
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!
      this.shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Viewing shader could not be compiled.')
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Viewing shader could not be linked.')
    gl.useProgram(program)
    gl.uniform1i(gl.getUniformLocation(program, 'image'), 0)
    gl.uniform1i(gl.getUniformLocation(program, 'table'), 1)
    gl.uniform1i(gl.getUniformLocation(program, 'grid'), lut?.size ?? 2)
    this.videoTexture = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture)
    for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE)
    for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    this.lutTexture = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    const size = lut?.size ?? 2
    const values = new Float32Array(size ** 3 * 4)
    if (lut) for (let i = 0; i < size ** 3; i++) {
      values[i * 4] = lut.values[i * 3]
      values[i * 4 + 1] = lut.values[i * 3 + 1]
      values[i * 4 + 2] = lut.values[i * 3 + 2]
      values[i * 4 + 3] = 1
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, size, size, size, 0, gl.RGBA, gl.FLOAT, values)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Viewing LUT could not be uploaded.')
  }

  draw(video: HTMLVideoElement, enabled: boolean) {
    if (video.readyState < 2 || !video.videoWidth || video.seeking) return false
    const gl = this.gl
    if (gl.isContextLost()) throw new Error('GPU viewing was interrupted.')
    // Inspect the decoder's actual declaration; original metadata stays intact.
    if (this.metadata.color.matrix === 'bt2020nc' && typeof VideoFrame !== 'undefined') {
      const frame = new VideoFrame(video)
      this.correct2020 = frame.colorSpace.matrix === 'bt709'
      frame.close()
    }
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight)
    const width = Math.max(1, Math.round(video.videoWidth * scale))
    const height = Math.max(1, Math.round(video.videoHeight * scale))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.useProgram(this.program)
    gl.uniform1i(gl.getUniformLocation(this.program, 'applyLut'), Number(enabled && !!this.lut))
    gl.uniform1i(gl.getUniformLocation(this.program, 'correct2020'), Number(this.correct2020))
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return true
  }

  dispose() {
    this.gl.deleteTexture(this.videoTexture)
    this.gl.deleteTexture(this.lutTexture)
    this.shaders.forEach((shader) => this.gl.deleteShader(shader))
    this.gl.deleteProgram(this.program)
  }
}
