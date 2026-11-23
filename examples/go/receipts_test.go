package receipts

import "testing"

func TestFormatReceiptKeepsAllEntries(t *testing.T) {
	entries := []Entry{{Name: " First ", Amount: 2}, {Name: "Second", Amount: 3, Paid: true}}
	got, err := FormatReceipt(entries)
	if err != nil || got != "First: 2\nSecond: 3\nTotal: 5" || entries[0].Name != " First " {
		t.Fatalf("FormatReceipt = %q, %v, entries = %+v", got, err, entries)
	}
}

func TestPaidReceiptFiltersAndValidates(t *testing.T) {
	entries := []Entry{{Name: " Paid ", Amount: 2, Paid: true}, {Name: "Pending", Amount: -1}}
	got, err := PaidReceipt(entries)
	if err != nil || got != "Paid: 2\nTotal: 2" {
		t.Fatalf("PaidReceipt = %q, %v", got, err)
	}
	if empty, err := PaidReceipt(nil); err != nil || empty != "Total: 0" {
		t.Fatalf("empty receipt = %q, %v", empty, err)
	}
	entries[1].Paid = true
	if _, err := PaidReceipt(entries); err == nil {
		t.Fatal("expected negative paid amount to fail")
	}
}
