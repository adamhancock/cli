import { List, ActionPanel, Action, Icon, showToast, Toast, Color } from '@raycast/api';
import { useState, useEffect } from 'react';
import { getChromeProfiles, type ChromeProfile } from './utils/chrome';
import { setSelectedChromeProfile, getSelectedChromeProfile, clearSelectedChromeProfile } from './utils/cache';

export default function SetChromeProfileCommand() {
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadProfiles();
  }, []);

  async function loadProfiles() {
    setIsLoading(true);

    try {
      // Load Chrome profiles
      const chromeProfiles = await getChromeProfiles();
      setProfiles(chromeProfiles);

      // Load currently selected profile
      const current = await getSelectedChromeProfile();
      setSelectedProfile(current);
    } catch (error) {
      console.error('Failed to load Chrome profiles:', error);
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to load Chrome profiles',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function selectProfile(profile: ChromeProfile) {
    try {
      await setSelectedChromeProfile(profile.path);
      setSelectedProfile(profile.path);

      await showToast({
        style: Toast.Style.Success,
        title: 'Chrome Profile Set',
        message: `Now using "${profile.name}" profile`,
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to set profile',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function clearProfile() {
    try {
      await clearSelectedChromeProfile();
      setSelectedProfile(undefined);

      await showToast({
        style: Toast.Style.Success,
        title: 'Chrome Profile Cleared',
        message: 'Will use default behavior',
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Failed to clear profile',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select Chrome profile to use...">
      {profiles.length === 0 && !isLoading && (
        <List.EmptyView
          icon={Icon.XMarkCircle}
          title="No Chrome Profiles Found"
          description="Make sure Google Chrome is installed"
        />
      )}

      {selectedProfile && (
        <List.Section title="Currently Selected">
          {profiles
            .filter((p) => p.path === selectedProfile)
            .map((profile) => (
              <List.Item
                key={profile.path}
                title={profile.name}
                subtitle={profile.path}
                icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
                accessories={[{ text: 'Selected', icon: Icon.Check }]}
                actions={
                  <ActionPanel>
                    <Action
                      title="Clear Selection"
                      icon={Icon.XMarkCircle}
                      onAction={clearProfile}
                      shortcut={{ modifiers: ['cmd'], key: 'delete' }}
                    />
                  </ActionPanel>
                }
              />
            ))}
        </List.Section>
      )}

      <List.Section title="Available Profiles">
        {profiles
          .filter((p) => p.path !== selectedProfile)
          .map((profile) => (
            <List.Item
              key={profile.path}
              title={profile.name}
              subtitle={profile.path}
              icon={profile.isDefault ? Icon.Star : Icon.Person}
              accessories={profile.isDefault ? [{ text: 'Default', icon: Icon.Star }] : []}
              actions={
                <ActionPanel>
                  <Action
                    title="Select This Profile"
                    icon={Icon.CheckCircle}
                    onAction={() => selectProfile(profile)}
                  />
                  {selectedProfile && (
                    <Action
                      title="Clear Selection"
                      icon={Icon.XMarkCircle}
                      onAction={clearProfile}
                      shortcut={{ modifiers: ['cmd'], key: 'delete' }}
                    />
                  )}
                </ActionPanel>
              }
            />
          ))}
      </List.Section>
    </List>
  );
}
