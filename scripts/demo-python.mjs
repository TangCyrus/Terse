import {runReuseDemo} from './lib/reuse-demo.mjs';

const command = process.env.TERSE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
runReuseDemo({example: 'python', file: 'receipts.py', symbols: ['format_receipt', 'ReceiptTests'],
  verification: {command, args: ['-B', '-m', 'unittest', '-v', 'test_receipts']},
  implement(original, variant) {
    const filtered = "\n\ndef export_paid_receipt(entries):\n    entries = [entry for entry in entries if entry['paid']]\n";
    return original + filtered + (variant === 'copy' ? original.slice(original.indexOf('\n') + 1) : '    return format_receipt(entries)\n');
  }});
