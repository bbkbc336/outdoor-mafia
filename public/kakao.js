// 카카오톡 안에서 열리면 외부 브라우저(안드로이드: 기본 브라우저, 아이폰: 사파리)로 바로 넘깁니다.
// 카카오톡 인앱 브라우저는 카메라·저장·화면 유지가 불안정하고, 창을 닫으면 입장 정보가 사라지기 쉽습니다.
// 다른 스크립트보다 먼저, <head>에서 불러옵니다. 오래된 휴대폰도 돌도록 옛 문법으로 씁니다.
(function () {
  var ua = navigator.userAgent || '';
  if (!/KAKAOTALK/i.test(ua)) return;
  var open = function () {
    if (window.__kakaoTest) { window.__kakaoTest.push(location.href); return; } // 시험용: 실제로 이동하지 않음
    location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
  };
  // 안내 화면을 먼저 띄우고 바로 외부 브라우저로 넘깁니다. 넘어간 뒤 카카오톡 창에는 이 안내가 남습니다.
  var show = function () {
    if (document.getElementById('kakaoOut')) return;
    var d = document.createElement('div');
    d.id = 'kakaoOut';
    d.setAttribute('style', 'position:fixed;inset:0;z-index:100;background:#0d0f14;color:#f4f6fb;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;font:18px/1.5 system-ui,sans-serif');
    d.innerHTML = '<div style="font-size:56px">🌐</div>'
      + '<b style="font-size:22px">외부 브라우저에서 열어 주세요</b>'
      + '<p style="margin:0;color:#a3abbf">카카오톡 안에서는 카메라와 화면 유지가 잘 되지 않습니다.</p>'
      + '<button id="kakaoOpen" style="font:inherit;font-weight:800;padding:16px 22px;border-radius:14px;border:0;background:#ffd23f;color:#1a1400;width:100%;max-width:340px">외부 브라우저로 열기</button>'
      + '<p style="margin:0;font-size:15px;color:#a3abbf">안 되면 오른쪽 아래(또는 위) <b>⋮</b> 메뉴 → <b>다른 브라우저로 열기</b></p>'
      + '<a id="kakaoStay" href="#" style="font-size:14px;color:#a3abbf">그냥 카카오톡에서 계속하기</a>';
    document.body.appendChild(d);
    document.getElementById('kakaoOpen').onclick = open;
    document.getElementById('kakaoStay').onclick = function (e) { e.preventDefault(); d.remove(); };
  };
  var go = function () { show(); setTimeout(open, 50); };
  if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
})();
