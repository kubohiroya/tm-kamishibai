/** Self-contained factory: embedded into the inert authoring extension without a UI dependency. */
export function createDsl4NarrativeRowsEditor(extensionId: string) {
  type Row = Record<string, string | number | boolean>;
  type Column = {name: string; type: string};
  type Draft = {rows: Row[]; columns: Column[]};
  type Issue = {message: string; path?: string};
  type Snapshot = {arguments: Record<string, {kind: string; value?: unknown}>};
  type Context = {
    getDraft(): unknown;
    setDraft(value: Record<string, unknown>): void;
    setValidationIssues(issues: Issue[]): void;
    getState(): {status: string};
    subscribe(listener: () => void): () => void;
  };
  const namePattern = /^[\p{L}_][\p{L}\p{N}_-]*$/u;
  const validName = (name: string) =>
    namePattern.test(name) &&
    name === name.normalize('NFC') &&
    !['__proto__', 'constructor', 'prototype'].includes(name);
  function issues(value: unknown): Issue[] {
    const draft = value as Draft;
    if (!draft || !Array.isArray(draft.rows) || !Array.isArray(draft.columns))
      return [{message: '一覧が不正です。'}];
    if (draft.rows.length > 1024 || draft.columns.length > 32)
      return [{message: '一覧は1024行・32列以下にしてください。'}];
    const names = draft.columns.map((column) => column.name);
    if (
      new Set(names).size !== names.length ||
      draft.columns.some(
        (column) =>
          !validName(column.name) || !['string', 'number', 'boolean'].includes(column.type),
      )
    )
      return [{message: '列名は重複しない識別子にし、列の型を選んでください。'}];
    for (const [index, row] of draft.rows.entries()) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length !== names.length
      )
        return [{message: `${index + 1}行目の列が一致しません。`}];
      for (const column of draft.columns)
        if (
          !Object.hasOwn(row, column.name) ||
          typeof row[column.name] !== column.type ||
          (column.type === 'number' && !Number.isFinite(row[column.name]))
        )
          return [
            {
              message: `${index + 1}行目「${column.name}」は列の型に合わせてください。`,
              path: `/rows/${index}/${column.name}`,
            },
          ];
    }
    return [];
  }
  return {
    apiVersion: 1,
    extensionId,
    editorId: 'narrative-rows-table',
    opcodes: [`${extensionId}_narrativeForEach`],
    editableArguments: ['ITEMS'],
    read(snapshot: Snapshot) {
      const slot = snapshot.arguments.ITEMS;
      if (slot?.kind !== 'literal' || typeof slot.value !== 'string')
        throw new TypeError('一覧は固定のJSON入力で編集してください。');
      const rows = JSON.parse(slot.value) as Row[];
      if (!Array.isArray(rows)) throw new TypeError('一覧には行の配列が必要です。');
      const first = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row));
      const columns = Object.entries(first ?? {}).map(([name, value]) => ({
        name,
        type: typeof value,
      }));
      return {rows, columns};
    },
    validate: issues,
    createPatch(value: unknown, snapshot: Snapshot) {
      if (issues(value).length) throw new TypeError('一覧の入力を確認してください。');
      const text = JSON.stringify((value as Draft).rows);
      const original = snapshot.arguments.ITEMS?.value;
      if (typeof original === 'string' && text === JSON.stringify(JSON.parse(original))) return [];
      return [{argument: 'ITEMS', value: text}];
    },
    mount(container: HTMLElement, context: Context) {
      const document = container.ownerDocument;
      const root = document.createElement('div');
      root.style.cssText = 'overflow:auto;max-width:100%;padding:8px;';
      root.setAttribute('data-kamishibai-narrative-rows', 'true');
      container.append(root);
      const draft = () => context.getDraft() as Draft;
      function publish(value: Draft, redraw = false) {
        if (context.getState().status !== 'editing') return;
        context.setDraft(value);
        context.setValidationIssues(issues(value));
        if (redraw) render();
      }
      function button(label: string, action: () => void) {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = label;
        element.style.cssText = 'margin:2px;padding:4px 8px;';
        element.addEventListener('click', action);
        return element;
      }
      function render() {
        root.replaceChildren();
        const current = draft();
        const hint = document.createElement('p');
        hint.textContent =
          '上から順に再生します。各列は同じ型に揃えてください。列名を変えた場合は値参照も更新してください。';
        root.append(hint);
        const table = document.createElement('table');
        table.style.cssText = 'border-collapse:collapse;width:100%;';
        table.setAttribute('aria-label', '各回の展開');
        const head = document.createElement('thead');
        const headings = document.createElement('tr');
        const position = document.createElement('th');
        position.textContent = '順序';
        headings.append(position);
        for (const [columnIndex, column] of current.columns.entries()) {
          const th = document.createElement('th');
          th.style.cssText = 'padding:6px;border:1px solid #aaa;';
          const name = document.createElement('input');
          name.value = column.name;
          name.setAttribute('aria-label', `${columnIndex + 1}列目の名前`);
          name.addEventListener('change', () => {
            const next = draft();
            const old = column.name;
            if (
              !validName(name.value) ||
              next.columns.some((entry, i) => i !== columnIndex && entry.name === name.value)
            ) {
              next.columns[columnIndex]!.name = name.value;
              publish(next);
              return;
            }
            for (const row of next.rows) {
              const value = row[old]!;
              delete row[old];
              row[name.value] = value;
            }
            next.columns[columnIndex]!.name = name.value;
            publish(next, true);
          });
          const type = document.createElement('select');
          type.setAttribute('aria-label', `${column.name}の型`);
          for (const [value, label] of [
            ['string', '文字列'],
            ['number', '数値'],
            ['boolean', '真偽値'],
          ]) {
            const option = document.createElement('option');
            option.value = value!;
            option.textContent = label!;
            type.append(option);
          }
          type.value = column.type;
          type.addEventListener('change', () => {
            const next = draft();
            next.columns[columnIndex]!.type = type.value;
            for (const row of next.rows) {
              const value = row[column.name];
              row[column.name] =
                type.value === 'string'
                  ? String(value)
                  : type.value === 'number' &&
                      String(value).trim() &&
                      Number.isFinite(Number(value))
                    ? Number(value)
                    : type.value === 'boolean' && (value === 'true' || value === 'false')
                      ? value === 'true'
                      : value!;
            }
            publish(next, true);
          });
          th.append(
            name,
            type,
            button('列を削除', () => {
              const next = draft();
              next.columns.splice(columnIndex, 1);
              for (const row of next.rows) delete row[column.name];
              publish(next, true);
            }),
          );
          headings.append(th);
        }
        head.append(headings);
        table.append(head);
        const body = document.createElement('tbody');
        for (const [rowIndex, row] of current.rows.entries()) {
          const tr = document.createElement('tr');
          const order = document.createElement('td');
          order.textContent = String(rowIndex + 1);
          for (const [label, offset] of [
            ['↑', -1],
            ['↓', 1],
          ] as const) {
            const move = button(label, () => {
              const next = draft();
              const target = rowIndex + offset;
              if (target < 0 || target >= next.rows.length) return;
              [next.rows[rowIndex], next.rows[target]] = [next.rows[target]!, next.rows[rowIndex]!];
              publish(next, true);
            });
            move.setAttribute('aria-label', `${rowIndex + 1}行目を${offset < 0 ? '上' : '下'}へ`);
            order.append(move);
          }
          order.append(
            button('行を削除', () => {
              const next = draft();
              next.rows.splice(rowIndex, 1);
              publish(next, true);
            }),
          );
          tr.append(order);
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            const td = document.createElement('td');
            td.colSpan = Math.max(1, current.columns.length);
            td.textContent = 'この行はオブジェクトではありません。削除して追加し直してください。';
            tr.append(td);
            body.append(tr);
            continue;
          }
          for (const column of current.columns) {
            const td = document.createElement('td');
            td.style.cssText = 'padding:6px;border:1px solid #aaa;';
            const input = document.createElement('input');
            input.type = column.type === 'boolean' ? 'checkbox' : 'text';
            input.setAttribute('aria-label', `${rowIndex + 1}行目 ${column.name}`);
            if (column.type === 'number') input.inputMode = 'decimal';
            input.value = String(row?.[column.name] ?? '');
            input.checked = row?.[column.name] === true;
            input.addEventListener('input', () => {
              const next = draft();
              const text = input.value;
              next.rows[rowIndex]![column.name] =
                column.type === 'boolean'
                  ? input.checked
                  : column.type === 'number' && text.trim() && Number.isFinite(Number(text))
                    ? Number(text)
                    : text;
              publish(next);
            });
            td.append(input);
            tr.append(td);
          }
          body.append(tr);
        }
        table.append(body);
        root.append(table);
        root.append(
          button('行を追加', () => {
            const next = draft();
            if (next.rows.length >= 1024) return;
            next.rows.push(
              Object.fromEntries(
                next.columns.map((column) => [
                  column.name,
                  column.type === 'number' ? 0 : column.type === 'boolean' ? false : '',
                ]),
              ),
            );
            publish(next, true);
          }),
        );
        const columnName = document.createElement('input');
        columnName.placeholder = '新しい列名';
        columnName.setAttribute('aria-label', '新しい列名');
        root.append(columnName);
        root.append(
          button('列を追加', () => {
            const next = draft();
            if (
              !validName(columnName.value) ||
              next.columns.length >= 32 ||
              next.columns.some((column) => column.name === columnName.value)
            ) {
              context.setValidationIssues([{message: '重複しない列名を入力してください。'}]);
              return;
            }
            next.columns.push({name: columnName.value, type: 'string'});
            for (const row of next.rows) row[columnName.value] = '';
            publish(next, true);
          }),
        );
      }
      const unsubscribe = context.subscribe(() => {
        const disabled = context.getState().status !== 'editing';
        for (const element of root.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLButtonElement
        >('input,select,button'))
          element.disabled = disabled;
      });
      context.setValidationIssues(issues(draft()));
      render();
      return () => {
        unsubscribe();
        root.remove();
      };
    },
  };
}
