/* If the snapshot bridge is not ready, still save flash and RAM. */
export function tryCaptureSession(capture) {
    try {
        return capture();
    } catch {
        return null;
    }
}
