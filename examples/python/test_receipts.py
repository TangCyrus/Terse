import unittest

from receipts import export_paid_receipt, format_receipt


class ReceiptTests(unittest.TestCase):
    def test_existing_receipt_includes_every_entry(self):
        entries = [{'name': ' First ', 'amount': 2}, {'name': 'Second', 'amount': 3}]
        self.assertEqual(format_receipt(entries), 'First: 2.00\nSecond: 3.00\nTotal: 5.00')
        self.assertEqual(entries[0]['name'], ' First ')

    def test_paid_receipt_filters_entries_and_preserves_validation(self):
        entries = [
            {'name': ' First ', 'amount': 2, 'paid': True},
            {'name': 'Pending', 'amount': -1, 'paid': False},
        ]
        self.assertEqual(export_paid_receipt(entries), 'First: 2.00\nTotal: 2.00')
        self.assertEqual(export_paid_receipt([]), 'Total: 0.00')
        entries[1]['paid'] = True
        with self.assertRaisesRegex(ValueError, 'negative amount'):
            export_paid_receipt(entries)
