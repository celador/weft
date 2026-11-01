// `import text from "./file?raw"` (Vite): the file's contents as a string.
declare module "*?raw" {
  const text: string;
  export default text;
}
