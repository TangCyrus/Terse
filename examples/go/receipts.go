package receipts

import (
	"fmt"
	"strings"
)

type Entry struct {
	Name   string
	Amount int
	Paid   bool
}

func FormatReceipt(entries []Entry) (string, error) {
	lines := make([]string, 0, len(entries)+1)
	total := 0
	for _, entry := range entries {
		amount := entry.Amount
		if amount < 0 {
			return "", fmt.Errorf("negative amount: %d", amount)
		}
		label := strings.TrimSpace(entry.Name)
		lines = append(lines, fmt.Sprintf("%s: %d", label, amount))
		total += amount
	}
	lines = append(lines, fmt.Sprintf("Total: %d", total))
	return strings.Join(lines, "\n"), nil
}
