import { HomeScreen } from "@/components/HomeScreen";
import { ProfileMenu } from "@/components/ProfileMenu";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <ProfileMenu />
      </header>
      <HomeScreen />
    </main>
  );
}
