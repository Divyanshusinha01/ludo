import {
  FOLK_BOARD_ALT,
  FOLK_BOARD_PNG,
  FOLK_BOARD_WEBP,
} from "@/lib/boardAsset";
import styles from "./BoardHeroImage.module.css";

type Props = {
  priority?: boolean;
  className?: string;
};

export function BoardHeroImage({ priority = false, className }: Props) {
  return (
    <div className={`${styles.wrap} ${className ?? ""}`}>
      <picture>
        <source srcSet={FOLK_BOARD_WEBP} type="image/webp" />
        <img
          src={FOLK_BOARD_PNG}
          alt={FOLK_BOARD_ALT}
          width={560}
          height={560}
          decoding="async"
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          className={styles.img}
        />
      </picture>
    </div>
  );
}
