'use strict';

const PanelCollapse = (() => {
  function init(container) {
    const headers = (container || document).querySelectorAll('.panel-header');
    headers.forEach(header => {
      if (header.dataset.collapseInit) return;
      header.dataset.collapseInit = '1';

      const isFlex = header.classList.contains('flex') ||
        getComputedStyle(header).display === 'flex';

      const icon = document.createElement('span');
      icon.className = 'panel-collapse-icon';
      icon.textContent = '\u25BE';

      if (isFlex) {
        const titleEl = header.querySelector(':scope > span');
        if (titleEl) {
          titleEl.classList.add('panel-header-title');
          titleEl.prepend(icon);
        } else {
          header.prepend(icon);
        }
      } else {
        header.prepend(icon);
      }

      header.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select')) return;
        header.closest('.panel').classList.toggle('collapsed');
      });
    });
  }

  return { init };
})();
