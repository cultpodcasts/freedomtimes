/**
 * Race a promise against a wall-clock deadline.
 * The underlying work is not aborted; callers use this to fail closed
 * instead of hanging the Worker isolate.
 */
export async function withDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}
