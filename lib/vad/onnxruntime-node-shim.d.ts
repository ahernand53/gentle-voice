/** Ambient shim — optionalDependency; not required at build time. */
declare module "onnxruntime-node" {
	export class Tensor {
		constructor(type: string, data: Float32Array | BigInt64Array | Int64Array, dims: number[]);
		readonly data: Float32Array | BigInt64Array | Int64Array;
	}
	export namespace InferenceSession {
		function create(
			path: string | Uint8Array,
			options?: object,
		): Promise<{
			run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
			release?(): Promise<void>;
		}>;
	}
}
