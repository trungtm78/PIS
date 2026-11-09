// Runs before the application: when the application has not replaced the loading placeholder of index.html in time (a script that did not load, a lost connection),
// the placeholder says so and offers the reload, so the page is never left with a spinner that stops nothing. The application removes the placeholder by rendering into #root.
(function () {
  var WAIT_MS = 20000;
  window.setTimeout(function () {
    var boot = document.querySelector('[data-boot]');
    if (boot === null) return;
    boot.className = 'boot boot-failed';
    boot.innerHTML = '';
    var title = document.createElement('p');
    title.className = 'boot-name';
    title.textContent = 'Chưa tải được ứng dụng';
    var wait = document.createElement('p');
    wait.className = 'boot-wait';
    wait.textContent = 'Kiểm tra kết nối mạng rồi tải lại trang.';
    var reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Tải lại trang';
    reload.onclick = function () {
      window.location.reload();
    };
    boot.appendChild(title);
    boot.appendChild(wait);
    boot.appendChild(reload);
  }, WAIT_MS);
})();
