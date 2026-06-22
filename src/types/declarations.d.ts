/**
 * 自定义类型声明 - 为没有 @types 的第三方包提供类型
 */

// ── ConvictConfig 全局接口 ────────────────────────
// 从 convict 模块声明中提取，方便其他文件直接引用
interface ConvictConfig {
  get(key: string): any;
  set(key: string, value: any): void;
  validate(options?: { allowed?: string; strict?: boolean }): void;
  getProperties(): Record<string, any>;
  load(env?: Record<string, string>): ConvictConfig;
  loadFile(filePath: string): ConvictConfig;
}

// ── convict 6.x ──────────────────────────────────
declare module 'convict' {
  interface ConvictFormat {
    name: string;
    validate?: (val: any) => void;
    coerce?: (val: any) => any;
  }

  interface ConvictProperty {
    doc: string;
    format: string | ConvictFormat;
    default: any;
    env?: string;
    sensitive?: boolean;
    validator?: (val: any) => void;
    coerce?: (val: any) => any;
  }

  interface ConvictConfig {
    get(key: string): any;
    set(key: string, value: any): void;
    validate(options?: { allowed?: string; strict?: boolean }): void;
    getProperties(): Record<string, any>;
    load(env?: Record<string, string>): ConvictConfig;
    loadFile(filePath: string): ConvictConfig;
  }

  interface ConvictStatic {
    (schema: Record<string, ConvictProperty>): ConvictConfig;
    addFormat(format: ConvictFormat): void;
    addFormats(formats: ConvictFormat[]): void;
  }

  const convict: ConvictStatic;
  export = convict;
}

// ── canvas (node-canvas) ─────────────────────────
declare module 'canvas' {
  export interface Canvas {
    width: number;
    height: number;
    getContext(contextId: '2d'): CanvasRenderingContext2D;
    getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
  }

  export interface CanvasRenderingContext2D {
    fillStyle: string;
    font: string;
    width: number;
    height: number;
    canvas: Canvas;
    fillRect(x: number, y: number, w: number, h: number): void;
    fillText(text: string, x: number, y: number, maxWidth?: number): void;
    measureText(text: string): TextMetrics;
    getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
  }

  export interface TextMetrics {
    width: number;
  }

  export interface ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }

  export function createCanvas(width: number, height: number): Canvas;
  export function registerFont(filePath: string, fontFace: { family: string; weight?: string; style?: string }): void;
}

// ── tesseract.js ─────────────────────────────────
declare module 'tesseract.js' {
  interface TesseractWord {
    text: string;
    bbox: { x0: number; y0: number; x1: number; y1: number };
    confidence: number;
  }

  interface TesseractData {
    text: string;
    words: TesseractWord[];
    confidence: number;
  }

  interface TesseractResult {
    data: TesseractData;
  }

  interface TesseractRecognizeOptions {
    tessedit_pageseg_mode?: string;
  }

  export function recognize(
    image: Buffer | string,
    lang: string,
    options?: TesseractRecognizeOptions
  ): Promise<TesseractResult>;
}

// ── onnxruntime-node 类型补充 ────────────────────
declare module 'onnxruntime-node' {
  export class Tensor {
    constructor(type: string, data: Float32Array | Int32Array | Uint8Array | number[], dims: number[]);
    data: Float32Array | Int32Array | Uint8Array | number[];
    dims: number[];
    type: string;
    size: number;
  }

  export interface SessionOptions {
    executionProviders?: string[];
    graphOptimizationLevel?: string;
  }

  export class InferenceSession {
    static create(modelPath: string, options?: SessionOptions): Promise<InferenceSession>;
    inputNames: string[];
    outputNames: string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
}
