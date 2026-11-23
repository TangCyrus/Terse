import {runReuseDemo} from './lib/reuse-demo.mjs';

runReuseDemo({example: 'go', file: 'receipts.go', symbols: ['FormatReceipt', 'Entry'],
  verification: {command: process.env.TERSE_GO || 'go', args: ['test', '-count=1', './...'], timeoutMs: 120_000},
  implement(original, variant) {
    const filtered = `
func PaidReceipt(entries []Entry) (string, error) {
    paid := make([]Entry, 0, len(entries))
    for _, entry := range entries {
        if entry.Paid {
            paid = append(paid, entry)
        }
    }
    entries = paid
`;
    const body = original.indexOf('\n', original.indexOf('func FormatReceipt(')) + 1;
    return original + filtered + (variant === 'copy' ? original.slice(body) : '\treturn FormatReceipt(entries)\n}\n');
  }});
