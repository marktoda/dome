import { ActivityEvent, ActivityAction } from './types.js';

export type ActivityState = ActivityEvent[];

const MAX_ACTIVITIES = 100;

export const initialActivityState: ActivityState = [];

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case 'ADD_ACTIVITY': {
      const newActivity: ActivityEvent = {
        ...action.payload,
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        timestamp: new Date(),
      };
      
      const updated = [...state, newActivity];
      
      // Keep only the last MAX_ACTIVITIES to prevent memory issues
      return updated.length > MAX_ACTIVITIES 
        ? updated.slice(-MAX_ACTIVITIES) 
        : updated;
    }
    
    case 'CLEAR_OLD_ACTIVITIES': {
      // Keep only activities from the last hour
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      return state.filter(activity => activity.timestamp > oneHourAgo);
    }
    
    default:
      return state;
  }
}