// Writes docs/qr.png: a QR code with the app URL for the Even app's scanner
// (the same plain-URL payload `evenhub qr` produces).
// Usage: node scripts/qr.mjs [url]
import { writeFileSync } from 'node:fs'
import qr from 'qr-image'

const url = process.argv[2] ?? 'https://bnuebel-dev.github.io/igor/'
writeFileSync('docs/qr.png', qr.imageSync(url, { type: 'png', size: 8, margin: 2 }))
console.log(`docs/qr.png -> ${url}`)
