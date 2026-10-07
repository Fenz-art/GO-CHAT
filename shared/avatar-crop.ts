export function avatarCropGeometry(width: number, height: number, outputSize = 512, zoom = 1, offsetX = 0, offsetY = 0) {
  const scale = Math.max(outputSize / width, outputSize / height) * zoom;
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  return {
    width: renderedWidth,
    height: renderedHeight,
    x: (outputSize - renderedWidth) / 2 + offsetX,
    y: (outputSize - renderedHeight) / 2 + offsetY,
  };
}
