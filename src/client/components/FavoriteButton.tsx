import { t } from "../i18n";
import { IconStar, IconStarFilled } from "./icons";

/** お気に入りの星ボタン (一覧の行とスケジュール画面のヘッダーで共通)。 */
export function FavoriteButton({ name, pressed, onToggle }: { name: string; pressed: boolean; onToggle: () => void }) {
  // aria-label は状態で変えない (状態は aria-pressed が伝える)。title だけ操作の説明にする。
  const label = t("list.favorite", { name });
  const title = t(pressed ? "list.favoriteRemove" : "list.favoriteAdd", { name });
  return (
    <button
      type="button"
      className={`fav-btn${pressed ? " on" : ""}`}
      aria-pressed={pressed}
      aria-label={label}
      title={title}
      data-testid="favorite-toggle"
      onClick={onToggle}
    >
      {pressed ? <IconStarFilled /> : <IconStar />}
    </button>
  );
}
