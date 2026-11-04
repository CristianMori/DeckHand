/**
 * The dashboard's own confirmation box, used wherever something is killed or
 * restarted. CANCEL holds the focus, so Enter and Escape both back out — the
 * destructive button must be chosen deliberately.
 */
export function confirmDialog(message: string, confirmLabel = 'OK'): Promise<boolean> {
  const dlg = document.getElementById('confirm-dialog') as HTMLDialogElement | null;
  // no dialog in the page (tests, odd embeddings): fall back to the native box
  if (!dlg) return Promise.resolve(confirm(message));

  dlg.innerHTML = '';
  const text = document.createElement('div');
  text.className = 'confirm-text';
  text.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = 'CANCEL';
  const ok = document.createElement('button');
  ok.className = 'ghost-btn danger';
  ok.textContent = confirmLabel;
  actions.append(cancel, ok);
  dlg.append(text, actions);

  return new Promise((resolve) => {
    let result = false;
    ok.onclick = () => {
      result = true;
      dlg.close();
    };
    cancel.onclick = () => dlg.close();
    dlg.onclose = () => resolve(result); // Escape lands here too, as a cancel
    dlg.showModal();
    cancel.focus();
  });
}
