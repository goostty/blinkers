// Lets tests import a file's text with `import text from './file?raw'` (a Vite feature).
declare module '*?raw' {
  const content: string;
  export default content;
}
