def format_receipt(entries):
    lines = []
    total = 0
    for entry in entries:
        amount = entry['amount']
        if amount < 0:
            raise ValueError('negative amount')
        label = entry['name'].strip()
        lines.append(f'{label}: {amount:.2f}')
        total += amount
    lines.append(f'Total: {total:.2f}')
    return '\n'.join(lines)
