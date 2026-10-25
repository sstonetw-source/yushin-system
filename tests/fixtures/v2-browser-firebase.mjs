// Actual compat SDK used by the original handlers, served only by the test host.
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/functions';
window.firebase=firebase;
