"use client";

import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { ProfileStats } from "./ProfileStats";
import { logOut, useAuthState } from "@/lib/auth";
import styles from "./ProfileMenu.module.css";

type Props = { onClose: () => void };

export function ProfileMenuPanel(props: Props) {
  return (
    <ConvexClientProvider>
      <PanelBody {...props} />
    </ConvexClientProvider>
  );
}

function PanelBody({ onClose }: Props) {
  const auth = useAuthState();
  const { isAuthenticated } = useConvexAuth();
  const profile = useQuery(api.profiles.getMine, isAuthenticated ? {} : "skip");

  return (
    <>
      <div className={styles.header}>
        <p className={styles.name}>{profile?.displayName ?? auth.profile?.displayName}</p>
        <p className={styles.handle}>@{auth.profile?.username}</p>
      </div>
      {profile ? (
        <ProfileStats profile={profile} />
      ) : (
        <p className={styles.status} role="status">
          Loading stats…
        </p>
      )}
      <div className={styles.footer}>
        <Link href="/profile" onClick={onClose}>
          Full profile
        </Link>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            onClose();
            void logOut();
          }}
        >
          Log out
        </button>
      </div>
    </>
  );
}
