import WikiContent from '../components/WikiContent';

/**
 * 百科攻略頁。2026-10-30 Edward：頂端的「Avalon 百科」標題與三格統計拿掉（直接看內容）；
 * 「線上實戰直播 & 數據分析回放」搬成導覽列自己的頁籤（StreamsPage）；頁尾的「社群貢獻」「遊戲提示」也拿掉。
 */
export default function WikiPage(): JSX.Element {
  return (
    <div className="min-h-screen">
      {/* Wiki 文章（心智圖／列表）+ modal 呈現（不跳頁） — 分類 chip 在 WikiContent 內 */}
      <div id="wiki-content">
        <WikiContent selectedCategory="" />
      </div>
    </div>
  );
}
