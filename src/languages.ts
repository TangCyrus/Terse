export const isPython = (file: string): boolean => /\.py$/i.test(file);

export function sourceFormat(file: string): string | undefined {
  if (isPython(file)) return 'python';
  if (/\.d\.[cm]?ts$|\.min\.[cm]?js$/i.test(file)) return undefined;
  if (/\.tsx$/i.test(file)) return 'tsx';
  if (/\.jsx$/i.test(file)) return 'jsx';
  if (/\.[cm]?ts$/i.test(file)) return 'typescript';
  if (/\.[cm]?js$/i.test(file)) return 'javascript';
  return undefined;
}
