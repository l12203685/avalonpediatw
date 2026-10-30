import StreamsSection from '../components/StreamsSection';

/**
 * 直播回放頁籤（Edward 2026-10-30：「YouTube 實戰直播回放本身也是一個頁籤，不要放在百科攻略裡」）。
 * 內容就是原本百科頁第二個分頁的直播回顧；頻道連結在導覽列的 YT。
 */
export default function StreamsPage(): JSX.Element {
  return (
    <div className="min-h-screen pb-10">
      <StreamsSection />
    </div>
  );
}
