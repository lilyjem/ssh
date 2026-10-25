/**
 * 返回缓冲区前缀中已经完整的 UTF-8 字节数。
 * 分页读取时丢掉末尾不完整的字符，下次从 next_offset 继续。
 */
export function completeUtf8Length(buffer: Buffer): number {
  const length = buffer.length;
  for (let back = 1; back <= 3 && back <= length; back++) {
    const index = length - back;
    const byte = buffer[index];
    if ((byte & 0b11000000) === 0b10000000) continue;

    let width = 1;
    if ((byte & 0b11100000) === 0b11000000) width = 2;
    else if ((byte & 0b11110000) === 0b11100000) width = 3;
    else if ((byte & 0b11111000) === 0b11110000) width = 4;
    if (back < width) return index;
    return length;
  }
  return length;
}
