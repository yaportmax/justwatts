// Open world's beta notice: resolves true on Continue, false on Cancel
export function betaOk() {
  const box = document.querySelector('#betaModal'), yes = box.querySelector('#betaYes'), no = box.querySelector('#betaNo');
  box.classList.add('on');
  return new Promise(done => { const end = v => { box.classList.remove('on'); yes.onclick = no.onclick = null; done(v); }; yes.onclick = () => end(true); no.onclick = () => end(false); });
}
