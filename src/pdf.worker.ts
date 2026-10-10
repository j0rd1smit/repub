// bundled by bun into out/ so the options and background pages load the pdfjs
// worker from our own origin (the default MV3 CSP blocks blob/eval workers)
import "pdfjs-dist/build/pdf.worker.min.mjs";
