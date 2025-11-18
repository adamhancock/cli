import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Detail,
} from '@raycast/api';
import { useState, useEffect, useRef } from 'react';
import {
  subscribeToEvents,
  loadRecentEvents,
  formatEvent,
  groupEventsByWorkspace,
  type FormattedEvent,
} from './utils/event-viewer-client';

export default function EventViewer() {
  const [events, setEvents] = useState<FormattedEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterWorkspace, setFilterWorkspace] = useState<string>('all');
  const [filterChannel, setFilterChannel] = useState<string>('all');
  const cleanupRef = useRef<(() => void) | null>(null);

  // Load initial data and subscribe to updates
  useEffect(() => {
    let isMounted = true;

    const loadData = async () => {
      try {
        const rawEvents = await loadRecentEvents(100);
        if (isMounted && rawEvents) {
          const formatted = rawEvents.map(formatEvent);
          setEvents(formatted);
          setIsLoading(false);
        } else if (isMounted && !rawEvents) {
          showToast({
            style: Toast.Style.Failure,
            title: 'Failed to load events',
            message: 'Redis not available',
          });
          setIsLoading(false);
        }
      } catch (error) {
        if (isMounted) {
          console.error('Failed to load events:', error);
          showToast({
            style: Toast.Style.Failure,
            title: 'Error loading events',
            message: String(error),
          });
          setIsLoading(false);
        }
      }
    };

    // Initial load
    loadData();

    // Subscribe to real-time updates
    const cleanup = subscribeToEvents(
      (updatedEvents) => {
        if (isMounted) {
          setEvents(updatedEvents);
        }
      },
      () => {
        if (isMounted) {
          showToast({
            style: Toast.Style.Failure,
            title: 'Subscription failed',
            message: 'Failed to subscribe to event updates',
          });
        }
      }
    );

    cleanupRef.current = cleanup;

    return () => {
      isMounted = false;
      cleanup();
    };
  }, []);

  // Get unique workspaces for filtering
  const workspaces = Array.from(new Set(events.map((e) => e.workspace_path || 'Global'))).sort();
  const channels = Array.from(new Set(events.map((e) => e.channel))).sort();

  // Filter events
  const filteredEvents = events.filter((event) => {
    if (filterWorkspace !== 'all') {
      const eventWorkspace = event.workspace_path || 'Global';
      if (eventWorkspace !== filterWorkspace) {
        return false;
      }
    }
    if (filterChannel !== 'all' && event.channel !== filterChannel) {
      return false;
    }
    return true;
  });

  // Group events by workspace
  const groupedEvents = groupEventsByWorkspace(filteredEvents);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search events..."
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter by workspace"
          value={filterWorkspace}
          onChange={setFilterWorkspace}
        >
          <List.Dropdown.Item title="All Workspaces" value="all" />
          {workspaces.map((workspace) => {
            const name = workspace.split('/').pop() || workspace;
            return <List.Dropdown.Item key={workspace} title={name} value={workspace} />;
          })}
        </List.Dropdown>
      }
    >
      {Array.from(groupedEvents.entries()).map(([workspace, workspaceEvents]) => {
        const workspaceName = workspace.split('/').pop() || workspace;

        return (
          <List.Section key={workspace} title={workspaceName} subtitle={`${workspaceEvents.length} events`}>
            {workspaceEvents.map((event, index) => (
              <EventItem key={`${event.timestamp}-${index}`} event={event} />
            ))}
          </List.Section>
        );
      })}

      {filteredEvents.length === 0 && !isLoading && (
        <List.EmptyView
          icon={Icon.Circle}
          title="No Events"
          description="No events found. Events will appear here as they occur."
        />
      )}
    </List>
  );
}

function EventItem({ event }: { event: FormattedEvent }) {
  return (
    <List.Item
      icon={{ source: Icon.Circle, tintColor: event.color }}
      title={event.title}
      subtitle={event.subtitle}
      accessories={[
        { text: event.relative_time },
        { icon: { source: Icon.Circle, tintColor: getChannelColor(event.channel) }, tooltip: event.channel },
      ]}
      actions={
        <ActionPanel>
          <Action.Push
            title="View Details"
            icon={Icon.Eye}
            target={<EventDetail event={event} />}
          />
          <Action.CopyToClipboard
            title="Copy Event Data"
            content={JSON.stringify(event.data, null, 2)}
            shortcut={{ modifiers: ['cmd'], key: 'c' }}
          />
          <Action.CopyToClipboard
            title="Copy Event JSON"
            content={JSON.stringify(event, null, 2)}
            shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
          />
        </ActionPanel>
      }
    />
  );
}

function EventDetail({ event }: { event: FormattedEvent }) {
  const markdown = `
# ${event.icon} ${event.title}

**Type:** ${event.event_type}
**Channel:** ${event.channel}
**Workspace:** ${event.workspace_name || 'Global'}
**Time:** ${new Date(event.timestamp).toLocaleString()} (${event.relative_time})

## Event Data

\`\`\`json
${JSON.stringify(event.data, null, 2)}
\`\`\`

## Full Event

\`\`\`json
${JSON.stringify(
  {
    id: event.id,
    timestamp: event.timestamp,
    channel: event.channel,
    event_type: event.event_type,
    workspace_path: event.workspace_path,
    created_at: event.created_at,
  },
  null,
  2
)}
\`\`\`
`;

  return (
    <Detail
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Event Type" text={event.event_type} icon={event.icon} />
          <Detail.Metadata.Label title="Channel" text={event.channel} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="Workspace"
            text={event.workspace_name || 'Global'}
            icon={Icon.Folder}
          />
          <Detail.Metadata.Label
            title="Timestamp"
            text={new Date(event.timestamp).toLocaleString()}
            icon={Icon.Clock}
          />
          <Detail.Metadata.Label title="Relative Time" text={event.relative_time} />
          <Detail.Metadata.Separator />
          {event.created_at && (
            <Detail.Metadata.Label
              title="Stored At"
              text={new Date(event.created_at).toLocaleString()}
            />
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action.CopyToClipboard
            title="Copy Event Data"
            content={JSON.stringify(event.data, null, 2)}
          />
          <Action.CopyToClipboard
            title="Copy Full Event"
            content={JSON.stringify(event, null, 2)}
            shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * Get color for channel badges
 */
function getChannelColor(channel: string): Color {
  if (channel.includes('claude')) return Color.Green;
  if (channel.includes('file')) return Color.Blue;
  if (channel.includes('git')) return Color.Purple;
  if (channel.includes('terminal')) return Color.SecondaryText;
  if (channel.includes('workspace')) return Color.Orange;
  if (channel.includes('notifications')) return Color.Yellow;
  if (channel.includes('updates')) return Color.Blue;
  if (channel.includes('chrome')) return Color.Green;
  return Color.SecondaryText;
}
