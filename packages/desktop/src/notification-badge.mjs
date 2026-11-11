/** Generate a tiny native bitmap so no SVG decoding or platform icon font is required. */
export function notificationBadge(nativeImage, base) {
    const size = 18;
    const pixels = base ? Buffer.from(base.resize({ width: size, height: size }).toBitmap()) : Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if ((x - 13) ** 2 + (y - 4) ** 2 > 16) continue;
        const i = (y * size + x) * 4;
        pixels[i] = 58; pixels[i + 1] = 58; pixels[i + 2] = 235; pixels[i + 3] = 255;
    }
    return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
