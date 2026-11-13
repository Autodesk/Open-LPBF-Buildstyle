/************************************************************
 * MODULE NAME: atu_param_group_class.js
 *
 * PURPOSE:
 *   Object oriented wrapper around the parameter builtins. A build
 *   style describes its parameters once as a tree of group objects
 *   (ClassAtuParamGroup) and parameter objects (ClassAtuParam).
 *   The same objects are used to DECLARE the parameters to the host
 *   (declareParameters) and to READ the values the user entered
 *   (all other entry points), so ids, defaults and ranges are written
 *   down only once.
 *
 * WORKFLOW:
 *   1. Module load: build the tree (new AtuParamGroup, createChildGrp,
 *      createParamReal, ...). Nothing is sent to the host yet.
 *   2. declareParameters: top_level_group.declare(a_build_param) for
 *      every top-level group -> the host shows the parameters in the UI.
 *   3. Every entry point that reads parameters: clearCachedValues()
 *      first, then param.getValue() / group.getParamVal('id') /
 *      group.isGrpEnabled().
 *
 * USAGE:
 *   See the detailed example below the 'requireBuiltin' lines.
 *
 * DEPENDENCIES:
 *   Builtins: bsParam (read values), bsBuildParam (group flags)
 *   Modules : none
 *
 * BACKGROUND:
 *   - Parameter tree: the UI shows the parameters as a tree. A group
 *     is a node (like a folder), a parameter is a leaf (a number field,
 *     check box, text field or drop down list).
 *   - Ids: every group and parameter has an id that is unique inside
 *     its parent. The full ("global") id is the path of all ids joined
 *     with '\', e.g. 'grp_hatching\grp_hatch_volume\hatch_distance'.
 *     The host stores the user values under these ids in the project,
 *     so ids must never be renamed.
 *   - Flags: a group can be optional (check box, on or off) and/or a
 *     platform group (one value for the whole build platform instead
 *     of one value per part).
 *   - Visibility: a parameter or group created with a_visible = false
 *     is never declared. Reading it returns its default value. This
 *     allows hiding a feature without changing the reading code.
 *   - Caching: reading a value from the host costs time, and the same
 *     value is read many times. Each object therefore remembers
 *     (caches) the value after the first read. Because the user can
 *     change values between two calculations, the cache must be
 *     cleared with clearCachedValues() at the start of every entry
 *     point. Note: in multi-threaded entry points every thread has its
 *     own script context with its own copy of this tree and its cache.
 *
 * Copyright (c) 2026, Autodesk Inc. (Original Author)
 ************************************************************/
'use strict';

//////////////////////////////////////////////////////

// bsParam: read the current parameter values and group states.
// bsBuildParam: constants (group flags) used when declaring groups.
var PARAM = requireBuiltin('bsParam');
var BUILD_PARAM = requireBuiltin('bsBuildParam');

//////////////////////////////////////////////////////

// A module to simplify parameter handling
// (declare parameters and read parameter values).
//
// Example:
//
// 'Require' this module:
//
// var PARAM_GROUP_MOD = require('lib/params/atu_param_group_class.js');
//
// Create a top-level group (multiple top-level groups can be created):
//
// let toplevel_group_1 =
//     new PARAM_GROUP_MOD.AtuParamGroup('toplevel_1_id',
//     'toplevel group 1 name',
//     'This is parameter group is the first top-level group',
//     BUILD_PARAM.nGroupDefaultFlags);
//
// Create a parameter inside the top-level group:
//
// let first_toplevel_param =
//     toplevel_group_1.createParamInt('first_param_id',
//     'first parameter name',
//     0, 100, 50,
//     'This is the first parameter of the first top-level group',
//     'mm');
//
// Create child group inside the top-level group:
//
// let child_group_1 =
//     toplevel_group_1.createChildGrp('child_group_1_id',
//     'child group 1 name',
//     'This is parameter group is the first child group of the first top-level group',
//     BUILD_PARAM.nGroupOptional | BUILD_PARAM.nGroupEnabled);
//
// Create a parameter inside the child group:
//
// let first_child_param =
//     child_group_1.createParamInt('first_param_id',
//     'first parameter name',
//     0, 100, 50,
//     'This is the first parameter of the first child group of the first top-level group',
//     'Watt');
//
//
// ////////////////////////////////
//
// Declare all top-level parameter groups
// (including the child groups and parameters)
// inside the 'declareParameters' entry point function:
//
// exports.declareParameters = function(parameter)
// {
//   toplevel_group_1.declare(parameter);
// };
//
// ////////////////////////////////
//
// Read parameter values:
//
// let first_toplevel_param_value = first_toplevel_param.getValue();
// let first_child_param_value = first_child_param.getValue();
//
// Or read by id (child group ids first, parameter id last):
//
// let same_value = toplevel_group_1.getParamVal('child_group_1_id', 'first_param_id');
//
// ////////////////////////////////
//
// Clear the cached values at the start of every entry point that
// reads parameters (the user may have changed values since the last
// call):
//
// toplevel_group_1.clearCachedValues();
//
// ////////////////////////////////
//
// How to add a new parameter
//   1. Call createParamReal / createParamInt / createParamBool / ...
//      on the group where the parameter shall appear in the UI.
//      Choose a new id that is unique inside this group.
//   2. Nothing else is needed for the declaration: declare() of the
//      top-level group declares all parameters of the tree.
//   3. Read the value with param.getValue() or group.getParamVal(id).
//
//////////////////////////////////////////////////////

// Parameter types. The type decides which create/declare/read
// functions are used for a parameter:
//   Int          - whole number with min / max (e.g. a layer count)
//   Real         - floating point number with min / max (e.g. mm, W)
//   Str          - single line text
//   Bool         - check box (true / false)
//   Choice       - drop down list; value as text AND as 0-based index
//   MultiLineStr - text with several lines
//   Base64Str    - text that holds Base64 encoded (binary) data
const S_Param_Type_Int = 'Int';
const S_Param_Type_Real = 'Real';
const S_Param_Type_Str = 'Str';
const S_Param_Type_Bool = 'Bool';
const S_Param_Type_Choice = 'Choice';
const S_Param_Type_MultiLineStr = 'MultiLineStr';
const S_Param_Type_Base64Str = 'Base64Str';

//////////////////////////////////////////////////////

/**
* Parameter class.
* One object describes one parameter (id, texts, default, type
* specific data such as min / max / unit / options) and caches its
* value after the first read.
* Tip: Do not create objects of this class directly. Use the
* createParamXxx() functions of a group, which also add the parameter
* to the group, so declare() and getParam() can find it.
*/
class ClassAtuParam
{

  /**
  * Constructor
  * @param  a_parent_group        Group of the parameter
  * @param  a_type                Parameter type (S_Param_Type_Int, S_Param_Type_Real,...)
  * @param  a_in_group_param_id   Id of the parameter (unique inside the group)
  * @param  a_display_name        Display name of the parameter (localized...)
  * @param  a_description         Description (tooltip...) of the parameter (localized...)
  * @param  a_default             Default value of the parameter
  *                               (for 'Choice': the displayed text of the default option)
  * @param  a_visible             Make the parameter visible in the UI or not.
  *                               Optional; anything other than a boolean means 'true'.
  */
  constructor(a_parent_group,
    a_type, a_in_group_param_id,
    a_display_name,
    a_description,
    a_default,
    a_visible)
  {
    this.m_type = a_type;
    this.m_parentGroup = a_parent_group;
    // Global id = path of the parent group plus the own id, separated
    // by a backslash ('\\' in a JS string is ONE backslash character).
    // The host identifies the parameter (and its saved value) by it.
    this.m_global_id = a_parent_group.m_global_id + '\\' + a_in_group_param_id;
    this.m_inGroupParam_id = a_in_group_param_id;
    this.m_displayName = a_display_name;
    this.m_description = a_description;
    this.m_default = a_default;
    // Cache flag: false = the value must (again) be read before use.
    this.m_valueIsValid = false;

    // a_visible is optional. Only an explicit 'false' hides the parameter.
    if(typeof a_visible === 'boolean')
    {
      this.m_visible = a_visible;
    }
    else
    {
      this.m_visible = true;
    }

    // Add function to invalidate the cached value.
    // The next getValue() call then reads the value from the host again.
    this.clearCachedValue = function()
      {
        this.m_valueIsValid = false;
      };

    // Add function(s) to the parameter object
    // to get the parameter value,
    // depending on parameter type.
    // Parameter value is cached.
    //
    // All getValue() variants follow the same pattern:
    //   - Cached value valid -> return it without asking the host.
    //   - Parameter and all parent groups visible -> read the value
    //     from the host with the group id and the parameter id.
    //   - Otherwise the parameter was never declared, so the host does
    //     not know it -> use the default value of the parameter.
    // Tip: The function is chosen ONCE here, in the
    // constructor, so getValue() does not need to check the type on
    // every call.
    if(this.m_type == S_Param_Type_Int)
    {
      this.getValue = function()
        {
          if(!this.m_valueIsValid)
          {
            if(this.m_visible && this.m_parentGroup.isGrpVisible())
            {
              this.m_value = PARAM.getParamInt(this.m_parentGroup.m_global_id,
                this.m_global_id);
            } // if
            else
            {
              this.m_value = this.m_default;
            } // else
            this.m_valueIsValid = true;
          } // if
          return this.m_value;
        };
    } // if
    else
    if(this.m_type == S_Param_Type_Real)
    {
      this.getValue = function()
        {
          if(!this.m_valueIsValid)
          {
            if(this.m_visible && this.m_parentGroup.isGrpVisible())
            {
              this.m_value = PARAM.getParamReal(this.m_parentGroup.m_global_id,
                this.m_global_id);
            } // if
            else
            {
              this.m_value = this.m_default;
            } // else
            this.m_valueIsValid = true;
          } // if
          return this.m_value;
        };
    } // if
    else
    if(this.m_type == S_Param_Type_Bool)
    {
      this.getValue = function()
        {
          if(!this.m_valueIsValid)
          {
            if(this.m_visible && this.m_parentGroup.isGrpVisible())
            {
              this.m_value = PARAM.getParamBool(this.m_parentGroup.m_global_id,
                this.m_global_id);
            } // if
            else
            {
              this.m_value = this.m_default;
            } // else
            this.m_valueIsValid = true;
          } // if
          return this.m_value;
        };
    } // if
    else
    if(this.m_type == S_Param_Type_Choice)
    {
      // Reads BOTH representations of the selected option at once:
      //   m_valueStr - displayed (localized) text, depends on the language
      //   m_valueInt - 0-based index in the option list, language independent
      // Tip: Use the index (getValueInt) in program logic, so
      // the script behaves the same in every UI language.
      this.internalReadChoiceValue = function()
        {
          if(this.m_visible && this.m_parentGroup.isGrpVisible())
          {
            this.m_valueStr = PARAM.getParamStr(this.m_parentGroup.m_global_id,
              this.m_global_id);
            this.m_valueInt = PARAM.getParamInt(this.m_parentGroup.m_global_id,
              this.m_global_id);
          } // if
          else
          {
            // Not declared: the default text is the value; its index is
            // searched in the option list. The options can be given as
            // one string "a;b;c" or as an array ["a","b","c"].
            // indexOf returns -1 if the default is not one of the options.
            this.m_valueStr = this.m_default;
            if(typeof this.m_options === 'string')
            {
              let l_str_array = this.m_options.split(';');
              this.m_valueInt = l_str_array.indexOf(this.m_default);
            }
            else
            {
              this.m_valueInt = this.m_options.indexOf(this.m_default);
            } // else
          } // else
          this.m_valueIsValid = true;
        };
      
      // 'Choice' parameter value:
      // string and int
      // getValue() returns the displayed text (same as getValueStr()).
      this.getValue = function()
        {
          if(!this.m_valueIsValid)
          {
            this.internalReadChoiceValue();
          } // if
          return this.m_valueStr;
        };
      this.getValueStr = function()
        {
          if(!this.m_valueIsValid)
          {
            this.internalReadChoiceValue();
          } // if
          return this.m_valueStr;
        };
      this.getValueInt = function()
        {
          if(!this.m_valueIsValid)
          {
            this.internalReadChoiceValue();
          } // if
          return this.m_valueInt;
        };
    } // if
    else
    // All three text types are read the same way, as a string.
    if((this.m_type == S_Param_Type_Str)
      || (this.m_type == S_Param_Type_MultiLineStr)
      || (this.m_type == S_Param_Type_Base64Str))
    {
      this.getValue = function()
        {
          
          if(!this.m_valueIsValid)
          {
            if(this.m_visible && this.m_parentGroup.isGrpVisible())
            {
              this.m_value = PARAM.getParamStr(this.m_parentGroup.m_global_id,
                this.m_global_id);
            } // if
            else
            {
              this.m_value = this.m_default;
            } // else
            this.m_valueIsValid = true;
          } // if
          return this.m_value;
        };
    } // if
    else
    {
      // An unknown type is a programming error in the build style
      // (not a user error). It shows up when the tree is built at
      // module load, so throwing an exception is acceptable here.
      throw new Error('Unknown parameter type');
    } // else
  };


}; // class ClassAtuParam

//////////////////////////////////////////////////////

/**
* Parameter group class.
* A group is one node of the parameter tree in the UI. It holds its
* parameters and child groups, declares them to the host and caches
* the group state (optional / enabled / platform).
* Exported as 'AtuParamGroup'. Use 'new AtuParamGroup(...)' only for
* top-level groups; create child groups with createChildGrp().
*/
class ClassAtuParamGroup
{
  /**
  * Constructor
  * @param  a_group_id                Id of the group (unique inside the group, if group is a child group)
  * @param  a_group_display_name      Display name of the group (localized...)
  * @param  a_group_description       Description (tooltip...) of the group (localized...)
  * @param  a_group_flags             Flags (e.g. bsBuildParam.nGroupOptional | bsBuildParam.nGroupEnabled,...)
  * @param  a_visible                 Make the parameter group visible in the UI or not.
  *                                   Optional; anything other than a boolean means 'true'.
  */
  constructor(a_group_id, a_group_display_name, a_group_description, a_group_flags, a_visible)
  {
    // These values describe a top-level group. createChildGrp() and
    // addChildGrpCopy() overwrite parent, global id and display name
    // after the construction of a child group.
    this.m_parentGroup = undefined;
    this.m_global_id = a_group_id;
    this.m_inGroup_id = a_group_id;
    this.m_inGroupDisplayName = a_group_display_name;
    this.m_displayName = a_group_display_name;
    this.m_description = a_group_description;
    this.m_flags = a_group_flags;
    // Children are stored twice: the maps give fast lookup by id
    // (getParam, getChildGrp), the arrays keep the creation order,
    // which is the order in the UI (declare).
    this.m_mapInGroupParamIdToChildParam = new Map;
    this.m_mapInGroupIdToChildGroup = new Map;
    this.m_childParamsArray = [];
    this.m_childGroupsArray = [];
    // Cache flag of the group state (see updateGroupInfo).
    this.m_groupInfoIsValid = false;

    if(typeof a_visible === 'boolean')
    {
      this.m_visible = a_visible;
    }
    else
    {
      this.m_visible = true;
    }
    
    // Read and cache the group state:
    //   m_isOptional - group has a check box in the UI
    //   m_isEnabled  - check box is on (always true for non-optional groups)
    //   m_isPlatform - group belongs to the platform settings
    // A visible group asks the host, because the user can switch the
    // check box. A hidden group was never declared, so its state is
    // derived from its own flags ('&' tests if a flag bit is set).
    this.updateGroupInfo = function()
      {
        if(this.isGrpVisible())
        {
          this.m_isOptional = PARAM.isGroupOptional(this.m_global_id);
          this.m_isEnabled = PARAM.isGroupEnabled(this.m_global_id);
          this.m_isPlatform = PARAM.isGroupPlatform(this.m_global_id);
        } // if
        else
        {
          this.m_isOptional = ((this.m_flags & BUILD_PARAM.nGroupOptional) == BUILD_PARAM.nGroupOptional);
          if(this.m_isOptional)
          {
            this.m_isEnabled = ((this.m_flags & BUILD_PARAM.nGroupEnabled) == BUILD_PARAM.nGroupEnabled);
          }
          else
          {
            this.m_isEnabled = true;
          }
          this.m_isPlatform = ((this.m_flags & BUILD_PARAM.nGroupPlatform) == BUILD_PARAM.nGroupPlatform);
        } // else
        this.m_groupInfoIsValid = true;
      };
  };

  /**
  * Invalidate the cached group state of THIS group only.
  * Use clearCachedValues() to clear the whole subtree.
  */
  clearCachedValue()
  {
    this.m_groupInfoIsValid = false;
  };

  /** Check if group is optional */
  isGrpOptional()
  {
    if(!this.m_groupInfoIsValid)
    {
      this.updateGroupInfo();
    } // if
    return this.m_isOptional;
  };

  /**
  * Check if group is enabled.
  * Tip: This is the state of the check box of an optional
  * group, e.g. "line stipple on / off". Only the state of THIS group
  * is queried; the parent groups are not looked at.
  * @return {boolean} true if enabled (always true for non-optional groups)
  */
  isGrpEnabled()
  {
    if(!this.m_groupInfoIsValid)
    {
      this.updateGroupInfo();
    } // if
    return this.m_isEnabled;
  };

  /** Check if group is related to platform */
  isGrpPlatform()
  {
    if(!this.m_groupInfoIsValid)
    {
      this.updateGroupInfo();
    } // if
    return this.m_isPlatform;
  };

  /**
  * Check if group is visible.
  * A group is only visible if it AND all its parent groups are
  * visible, so the check walks up the tree to the top-level group.
  * @return {boolean} true if the group is declared to the host
  */
  isGrpVisible()
  {
    if(!this.m_visible) return false;
    if((typeof this.m_parentGroup === 'undefined') || (this.m_parentGroup === null)) return true;
    return this.m_parentGroup.isGrpVisible();
  };

  /**
  * Get parameter inside this group.
  * If groups are given before the parameter argument, then the first group is visited and
  * inside that group the next given group is visited, and so on.
  * Example: grp.getParam('grp_rotation', 'grp_rotation_limit', 'limit_width')
  * Tip: 'arguments' is the list of ALL values passed to a
  * function, even if the function names only one parameter. Here the
  * last argument is the parameter id, all others are child group ids.
  * Throws an Error if a group or the parameter does not exist. That is
  * a programming error (wrong id in the script), not a user error.
  * @param    a_in_group_param_id     Id of parameter (unique inside this group)
  * @return   Parameter object (ClassAtuParam)
  */
  getParam(a_in_group_param_id)
  {
    let l_grp_count = arguments.length - 1;
    let l_param_grp = this;
    let l_prev_param_grp = undefined;

    for(let i=0;i<l_grp_count;++i)
    {
      l_prev_param_grp = l_param_grp;
      l_param_grp = l_param_grp.getChildGrp(arguments[i]);
      if((typeof l_param_grp === 'undefined') || (l_param_grp === null))
      {
        throw new Error("Child Parameter Group '"+arguments[i]+"' not found in group '" +l_prev_param_grp.m_displayName+ "'.");
      } // if
    } // for

    let l_param = l_param_grp.m_mapInGroupParamIdToChildParam.get(arguments[arguments.length - 1]);
    if((typeof l_param === 'undefined') || (l_param === null))
    {
      throw new Error("Parameter '"+arguments[arguments.length - 1]+"' not found in group '" +l_param_grp.m_displayName+ "'.");
    } // if
    return l_param;
  };

  /**
  * Get value of parameter inside this group.
  * If groups are given before the parameter argument, then the first group is visited and
  * inside that group the next given group is visited, and so on.
  * Same lookup as getParam(), followed by getValue() (cached value).
  * For 'Choice' parameters this returns the displayed text; use
  * getParam(...).getValueInt() to get the language independent index.
  * @param    a_in_group_param_id     Id of parameter (unique inside this group)
  * @return   Parameter value
  */
  getParamVal(a_in_group_param_id)
  {
    let l_grp_count = arguments.length - 1;
    let l_param_grp = this;
    let l_prev_param_grp = undefined;

    for(let i=0;i<l_grp_count;++i)
    {
      l_prev_param_grp = l_param_grp;
      l_param_grp = l_param_grp.getChildGrp(arguments[i]);
      if((typeof l_param_grp === 'undefined') || (l_param_grp === null))
      {
        throw new Error("Child Parameter Group '"+arguments[i]+"' not found in group '" +l_prev_param_grp.m_displayName+ "'.");
      } // if
    } // for

    let l_param = l_param_grp.m_mapInGroupParamIdToChildParam.get(arguments[arguments.length - 1]);
    if((typeof l_param === 'undefined') || (l_param === null))
    {
      throw new Error("Parameter '"+arguments[arguments.length - 1]+"' not found in group '" +l_param_grp.m_displayName+ "'.");
    } // if
    return l_param.getValue();
  };

  /**
  * Get child group inside this group.
  * If more than one group is given, then the first group is visited and
  * inside that group the next given group is visited, and so on.
  * Note: Unlike getParam(), a missing LAST group is not an error: the
  * function then returns undefined. The parameter readers rely on this
  * to detect optional child groups that were not created.
  * @param    a_in_group_id     Id of child group (unique inside this group)
  * @return   Group object (ClassAtuParamGroup), or undefined if not found
  */
  getChildGrp(a_in_group_id)
  {
    let l_grp_count_minus_one = arguments.length - 1;
    let l_param_grp = this;
    let l_prev_param_grp = undefined;

    for(let i=0;i<l_grp_count_minus_one;++i)
    {
      // Remember the parent: after a failed lookup l_param_grp is
      // undefined, and the error message needs the name of the parent.
      l_prev_param_grp = l_param_grp;
      l_param_grp = l_param_grp.getChildGrp(arguments[i]);
      if((typeof l_param_grp === 'undefined') || (l_param_grp === null))
      {
        throw new Error("Child Parameter Group '"+arguments[i]+"' not found in group '" +l_prev_param_grp.m_displayName+ "'.");
      } // if
    } // for

    return l_param_grp.m_mapInGroupIdToChildGroup.get(arguments[arguments.length - 1]);
  };

  /**
  * Create a new child group inside this group
  * @param  a_in_group_id             Id of new the group (unique inside this group)
  * @param  a_group_display_name      Display name of the new group (localized...)
  * @param  a_group_description       Description (tooltip...) of the new group (localized...)
  * @param  a_group_flags             Flags (e.g. bsBuildParam.nGroupOptional | bsBuildParam.nGroupEnabled,...) of the new group
  * @param  a_visible                 Make the parameter group visible in the UI or not.
  * @return The group object (ClassAtuParamGroup) of the new group
  */
  createChildGrp(a_in_group_id, a_group_display_name, a_group_description, a_group_flags, a_visible)
  {
    // The display name passed to the host is the full path of the
    // display names ('Parent\Child'); the global id is the path of the
    // ids ('parent_id\child_id'). Both are joined with a backslash.
    let l_new_grp = new ClassAtuParamGroup(a_in_group_id,
      this.m_displayName + '\\' + a_group_display_name,
      a_group_description, a_group_flags, a_visible);
    l_new_grp.m_inGroupDisplayName = a_group_display_name;
    l_new_grp.m_global_id = this.m_global_id + '\\' + a_in_group_id;
    l_new_grp.m_parentGroup = this;

    this.m_mapInGroupIdToChildGroup.set(a_in_group_id, l_new_grp);
    this.m_childGroupsArray.push(l_new_grp);
    return l_new_grp;
  };

  /**
  * Add a copy of an existing group as a new child group to this group.
  * All parameters and child groups of the source are copied
  * recursively (ids, texts, ranges, defaults, visibility). The copy is
  * independent: it has its own global ids and therefore its own values.
  * Typical use: the same settings block in several places of the tree.
  * @param  a_source_grp              Source group for copy.
  * @param  a_in_group_id             Id of new the group (unique inside this group).
  *                                   If group id is undefined then the in-group-id of the source group is used.
  * @param  a_group_display_name      Display name of the new group (localized...)
  *                                   If display name is undefined then the display name of the source group is used.
  * @param  a_group_description       Description (tooltip...) of the new group (localized...)
  *                                   If description is undefined then the description of the source group is used.
  * @param  a_group_flags             Flags (e.g. bsBuildParam.nGroupOptional | bsBuildParam.nGroupEnabled,...) of the new group
  *                                   If flags are undefined then the flags of the source group are used.
  * @param  a_visible                 Make the parameter group visible in the UI or not.
  * @return The group object (ClassAtuParamGroup) of the new group
  */
  addChildGrpCopy(a_source_grp, a_in_group_id, a_group_display_name,
    a_group_description, a_group_flags, a_visible)
  {
    // Every argument after a_source_grp is optional: undefined or null
    // means "take the value of the source group".
    let l_in_grp_id = a_in_group_id;
    if((typeof l_in_grp_id === 'undefined') || (l_in_grp_id === null))
    {
      l_in_grp_id = a_source_grp.m_inGroup_id;
    } // if

    let l_in_grp_display_name = a_group_display_name;
    if((typeof l_in_grp_display_name === 'undefined') || (l_in_grp_display_name === null))
    {
      l_in_grp_display_name = a_source_grp.m_inGroupDisplayName;
    } // if

    let l_grp_desc = a_group_description;
    if((typeof l_grp_desc === 'undefined') || (l_grp_desc === null))
    {
      l_grp_desc = a_source_grp.m_description;
    } // if

    let l_grp_flags = a_group_flags;
    if((typeof l_grp_flags === 'undefined') || (l_grp_flags === null))
    {
      l_grp_flags = a_source_grp.m_flags;
    } // if

    let l_grp_visible = a_visible;
    if((typeof l_grp_visible === 'undefined') || (l_grp_visible === null))
    {
      l_grp_visible = a_source_grp.m_visible;
    } // if

    let l_new_grp = new ClassAtuParamGroup(l_in_grp_id,
      this.m_displayName + '\\' + l_in_grp_display_name,
      l_grp_desc, l_grp_flags, l_grp_visible);
    l_new_grp.m_inGroupDisplayName = l_in_grp_display_name;
    l_new_grp.m_global_id = this.m_global_id + '\\' + l_in_grp_id;
    l_new_grp.m_parentGroup = this;

    this.m_mapInGroupIdToChildGroup.set(l_in_grp_id, l_new_grp);
    this.m_childGroupsArray.push(l_new_grp);

    // Create a parameter of the same type with the same properties in
    // a_target_grp. Uses the normal createParamXxx() functions, so the
    // copy gets a new global id below the new group.
    let add_param_copy = function(a_source_param, a_target_grp)
    {
      if(a_source_param.m_type == S_Param_Type_Int)
      {
        return a_target_grp.createParamInt
          (a_source_param.m_inGroupParam_id,
          a_source_param.m_displayName,
          a_source_param.m_min, a_source_param.m_max, a_source_param.m_default,
          a_source_param.m_description, a_source_param.m_unit,
          a_source_param.m_visible);
      } // if

      if(a_source_param.m_type == S_Param_Type_Real)
      {
        return a_target_grp.createParamReal
          (a_source_param.m_inGroupParam_id,
          a_source_param.m_displayName,
          a_source_param.m_min, a_source_param.m_max, a_source_param.m_default,
          a_source_param.m_description, a_source_param.m_unit,
          a_source_param.m_visible);
      } // if

      if(a_source_param.m_type == S_Param_Type_Bool)
      {
        return a_target_grp.createParamBool
          (a_source_param.m_inGroupParam_id,
          a_source_param.m_displayName,
          a_source_param.m_default,
          a_source_param.m_description,
          a_source_param.m_visible);
      } // if

      if(a_source_param.m_type == S_Param_Type_Choice)
      {
        return a_target_grp.createParamChoice
          (a_source_param.m_inGroupParam_id,
          a_source_param.m_displayName,
          a_source_param.m_options,
          a_source_param.m_default,
          a_source_param.m_description,
          a_source_param.m_unit,
          a_source_param.m_visible);
      } // if

      if(a_source_param.m_type == S_Param_Type_Str)
      {
        return a_target_grp.createParamStr
          (a_source_param.m_inGroupParam_id,
          a_source_param.m_displayName,
          a_source_param.m_default,
          a_source_param.m_description,
          a_source_param.m_visible);
      } // if

      if(a_source_param.m_type == S_Param_Type_MultiLineStr)
      {
        return a_target_grp.createParamMultiLineStr
          (a_source_param.m_inGroupParam_id,
          a_source_param.m_displayName,
          a_source_param.m_default,
          a_source_param.m_description,
          a_source_param.m_visible);
      } // if

      if(a_source_param.m_type == S_Param_Type_Base64Str)
      {
        return a_target_grp.createParamBase64Str
          (a_source_param.m_inGroupParam_id,
          a_source_param.m_displayName,
          a_source_param.m_default,
          a_source_param.m_description,
          a_source_param.m_visible);
      } // if

      throw new Error('Unknown parameter type');
    };

    let l_param_count = a_source_grp.m_childParamsArray.length;
    for(let i=0;i<l_param_count;++i)
    {
      add_param_copy(a_source_grp.m_childParamsArray[i], l_new_grp);
    } // for

    // Recursion: child groups of the source are copied with their own
    // ids, texts, flags and visibility (no overrides).
    let l_grp_count = a_source_grp.m_childGroupsArray.length;
    for(let i=0;i<l_grp_count;++i)
    {
      l_new_grp.addChildGrpCopy(a_source_grp.m_childGroupsArray[i]);
    } // for

    return l_new_grp;
  };

  /**
  * Create a new integer parameter inside this group
  * The min / max limits are the range the UI accepts. They protect
  * against impossible input; they are not recommended process values.
  * @param  a_in_group_param_id     Id of the new parameter (unique inside the group)
  * @param  a_param_display_name    Display name of the new parameter (localized...)
  * @param  a_min                   Min value of the new parameter
  * @param  a_max                   Max value of the new parameter
  * @param  a_default               Default value of the new parameter
  * @param  a_param_description     Description (tooltip...) of the new parameter (localized...)
  * @param  a_unit                  Unit of the new parameter (localized...)
  * @param  a_visible               Make the parameter visible in the UI or not.
  * @return The parameter object (ClassAtuParam) of the new parameter
  */
  createParamInt(a_in_group_param_id, a_param_display_name,
    a_min, a_max, a_default, a_param_description, a_unit, a_visible)
  {
    let l_new_param =
      new ClassAtuParam(this,
        S_Param_Type_Int, a_in_group_param_id,
        a_param_display_name,
        a_param_description,
        a_default, a_visible);
    l_new_param.m_min = a_min;
    l_new_param.m_max = a_max;
    l_new_param.m_unit = a_unit;

    this.m_mapInGroupParamIdToChildParam.set(a_in_group_param_id, l_new_param);
    this.m_childParamsArray.push(l_new_param);
    return l_new_param;
  };

  /**
  * Create a new real parameter inside this group
  * 'Real' means a floating point number, e.g. a length in mm or a
  * power in W. The unit text is a label for the UI; this class does
  * not convert any values.
  * @param  a_in_group_param_id     Id of the new parameter (unique inside the group)
  * @param  a_param_display_name    Display name of the new parameter (localized...)
  * @param  a_min                   Min value of the new parameter
  * @param  a_max                   Max value of the new parameter
  * @param  a_default               Default value of the new parameter
  * @param  a_param_description     Description (tooltip...) of the new parameter (localized...)
  * @param  a_unit                  Unit of the new parameter (localized...)
  * @param  a_visible               Make the parameter visible in the UI or not.
  * @return The parameter object (ClassAtuParam) of the new parameter
  */
  createParamReal(a_in_group_param_id, a_param_display_name,
    a_min, a_max, a_default, a_param_description, a_unit, a_visible)
  {
    let l_new_param =
      new ClassAtuParam(this,
        S_Param_Type_Real, a_in_group_param_id,
        a_param_display_name,
        a_param_description,
        a_default, a_visible);
    l_new_param.m_min = a_min;
    l_new_param.m_max = a_max;
    l_new_param.m_unit = a_unit;

    this.m_mapInGroupParamIdToChildParam.set(a_in_group_param_id, l_new_param);
    this.m_childParamsArray.push(l_new_param);
    return l_new_param;
  };

  /**
  * Create a new choice parameter inside this group
  * The user selects one option of a drop down list. Read it with
  * getValueInt() (0-based index, language independent) or
  * getValueStr() (displayed text).
  * Tip: Only append new options at the end of the list;
  * inserting options changes the index of the following options.
  * @param  a_in_group_param_id     Id of the new parameter (unique inside the group)
  * @param  a_param_display_name    Display name of the new parameter (localized...)
  * @param  a_options               Options (localized...) (";" separated or Array of strings). E.g. "low;high;very high" or e.g. ["low","high","very high"])
  * @param  a_default               Default value of the new parameter (must be one of the elements listed in a_options)
  * @param  a_param_description     Description (tooltip...) of the new parameter (localized...)
  * @param  a_unit                  Unit of the new parameter (localized...)
  * @param  a_visible               Make the parameter visible in the UI or not.
  * @return The parameter object (ClassAtuParam) of the new parameter
  */
  createParamChoice(a_in_group_param_id, a_param_display_name,
    a_options, a_default, a_param_description, a_unit, a_visible)
  {
    let l_new_param =
      new ClassAtuParam(this,
        S_Param_Type_Choice, a_in_group_param_id,
        a_param_display_name,
        a_param_description,
        a_default, a_visible);
    l_new_param.m_options = a_options;
    l_new_param.m_unit = a_unit;

    this.m_mapInGroupParamIdToChildParam.set(a_in_group_param_id, l_new_param);
    this.m_childParamsArray.push(l_new_param);
    return l_new_param;
  };

  /**
  * Create a new boolean parameter inside this group
  * @param  a_in_group_param_id     Id of the new parameter (unique inside the group)
  * @param  a_param_display_name    Display name of the new parameter (localized...)
  * @param  a_default               Default value of the new parameter
  * @param  a_param_description     Description (tooltip...) of the new parameter (localized...)
  * @param  a_visible               Make the parameter visible in the UI or not.
  * @return The parameter object (ClassAtuParam) of the new parameter
  */
  createParamBool(a_in_group_param_id, a_param_display_name,
    a_default, a_param_description, a_visible)
  {
    let l_new_param =
      new ClassAtuParam(this,
        S_Param_Type_Bool, a_in_group_param_id,
        a_param_display_name,
        a_param_description,
        a_default, a_visible);

    this.m_mapInGroupParamIdToChildParam.set(a_in_group_param_id, l_new_param);
    this.m_childParamsArray.push(l_new_param);
    return l_new_param;
  };

  /**
  * Create a new string parameter inside this group
  * @param  a_in_group_param_id     Id of the new parameter (unique inside the group)
  * @param  a_param_display_name    Display name of the new parameter (localized...)
  * @param  a_default               Default value of the new parameter
  * @param  a_param_description     Description (tooltip...) of the new parameter (localized...)
  * @param  a_visible               Make the parameter visible in the UI or not.
  * @return The parameter object (ClassAtuParam) of the new parameter
  */
  createParamStr(a_in_group_param_id, a_param_display_name,
    a_default, a_param_description, a_visible)
  {
    let l_new_param =
      new ClassAtuParam(this,
        S_Param_Type_Str, a_in_group_param_id,
        a_param_display_name,
        a_param_description,
        a_default, a_visible);

    this.m_mapInGroupParamIdToChildParam.set(a_in_group_param_id, l_new_param);
    this.m_childParamsArray.push(l_new_param);
    return l_new_param;
  };

  /**
  * Create a new multi-line string parameter inside this group
  * @param  a_in_group_param_id     Id of the new parameter (unique inside the group)
  * @param  a_param_display_name    Display name of the new parameter (localized...)
  * @param  a_default               Default value of the new parameter
  * @param  a_param_description     Description (tooltip...) of the new parameter (localized...)
  * @param  a_visible               Make the parameter visible in the UI or not.
  * @return The parameter object (ClassAtuParam) of the new parameter
  */
  createParamMultiLineStr(a_in_group_param_id, a_param_display_name,
    a_default, a_param_description, a_visible)
  {
    let l_new_param =
      new ClassAtuParam(this,
        S_Param_Type_MultiLineStr, a_in_group_param_id,
        a_param_display_name,
        a_param_description,
        a_default, a_visible);

    this.m_mapInGroupParamIdToChildParam.set(a_in_group_param_id, l_new_param);
    this.m_childParamsArray.push(l_new_param);
    return l_new_param;
  };

  /**
  * Create a new base64 string parameter inside this group
  * Base64 encodes binary data (e.g. a small file) as plain text, so it
  * can be stored like any other text parameter.
  * @param  a_in_group_param_id     Id of the new parameter (unique inside the group)
  * @param  a_param_display_name    Display name of the new parameter (localized...)
  * @param  a_default               Default value of the new parameter
  * @param  a_param_description     Description (tooltip...) of the new parameter (localized...)
  * @param  a_visible               Make the parameter visible in the UI or not.
  * @return The parameter object (ClassAtuParam) of the new parameter
  */
  createParamBase64Str(a_in_group_param_id, a_param_display_name,
    a_default, a_param_description, a_visible)
  {
    let l_new_param =
      new ClassAtuParam(this,
        S_Param_Type_Base64Str, a_in_group_param_id,
        a_param_display_name,
        a_param_description,
        a_default, a_visible);

    this.m_mapInGroupParamIdToChildParam.set(a_in_group_param_id, l_new_param);
    this.m_childParamsArray.push(l_new_param);
    return l_new_param;
  };

  /**
  * 'Declare' this parameter group with parameters and all child groups with parameters recursively.
  * To be called inside the 'declareParameters' entry point function.
  * Order: first the group itself, then its parameters, then its child
  * groups (recursively). The order of creation is the order in the UI.
  * Hidden groups and parameters (a_visible = false) are skipped, so
  * they never appear in the UI; reading them returns the default.
  * @param  a_build_param bsBuildParam object. The argument of the declareParameters() entry point function.
  */
  declare(a_build_param)
  {
    if(!this.isGrpVisible()) return;
    
    a_build_param.declareParameterGroup(this.m_global_id,
      this.m_displayName,
      this.m_description,
      this.m_flags);

    let l_child_param_count = this.m_childParamsArray.length;
    for(let i=0;i<l_child_param_count;++i)
    {
      DeclareParameter(a_build_param, this.m_childParamsArray[i]);
    } // for

    let l_child_grp_count = this.m_childGroupsArray.length;
    for(let i=0;i<l_child_grp_count;++i)
    {
      DeclareGroupRecursive(a_build_param, this.m_childGroupsArray[i]);
    } // for

  };

  /**
  * Invalidate all cached values of all parameters in this parameter group and all child groups recursively.
  * Call it on every top-level group at the start of each entry point
  * that reads parameters. Without it, a value changed by the user after
  * the first read would be ignored and the old cached value used.
  * It is cheap: it only resets flags, the values are read again lazily
  * (on the next getValue() call).
  */
  clearCachedValues()
  {
    this.clearCachedValue();
    let l_child_param_count = this.m_childParamsArray.length;
    for(let i=0;i<l_child_param_count;++i)
    {
      this.m_childParamsArray[i].clearCachedValue();
    } // for

    let l_child_grp_count = this.m_childGroupsArray.length;
    for(let i=0;i<l_child_grp_count;++i)
    {
      this.m_childGroupsArray[i].clearCachedValues();
    } // for

  };

}; // class ClassAtuParamGroup

//////////////////////////////////////////////////////

/**
* 'Declare' a parameter.
* Calls the declare function of bsBuildParam that matches the type.
* Each parameter is declared with the global id of its group and its
* own global id; reading uses the same two ids (see getValue()).
* Hidden parameters and parameters in hidden groups are skipped.
* @param  a_build_param  bsBuildParam object (argument of declareParameters)
* @param  a_param        Parameter object (ClassAtuParam)
*/
function DeclareParameter(a_build_param, a_param)
{
  if(!a_param.m_visible) return;
  if(!a_param.m_parentGroup.isGrpVisible()) return;

  if(a_param.m_type == S_Param_Type_Int)
  {
    a_build_param.declareParameterInt(a_param.m_parentGroup.m_global_id,
      a_param.m_global_id,
      a_param.m_displayName,
      a_param.m_min, a_param.m_max, a_param.m_default,
      a_param.m_description, a_param.m_unit);
    return;
  } // if

  if(a_param.m_type == S_Param_Type_Real)
  {
    a_build_param.declareParameterReal(a_param.m_parentGroup.m_global_id,
      a_param.m_global_id,
      a_param.m_displayName,
      a_param.m_min, a_param.m_max, a_param.m_default,
      a_param.m_description, a_param.m_unit);
    return;
  } // if

  if(a_param.m_type == S_Param_Type_Bool)
  {
    a_build_param.declareParameterBool(a_param.m_parentGroup.m_global_id,
      a_param.m_global_id,
      a_param.m_displayName,
      a_param.m_default,
      a_param.m_description);
    return;
  } // if

  if(a_param.m_type == S_Param_Type_Choice)
  {
    a_build_param.declareParameterChoice(a_param.m_parentGroup.m_global_id,
      a_param.m_global_id,
      a_param.m_displayName,
      a_param.m_options,
      a_param.m_default,
      a_param.m_description, a_param.m_unit);
    return;
  } // if

  if(a_param.m_type == S_Param_Type_Str)
  {
    a_build_param.declareParameterStr(a_param.m_parentGroup.m_global_id,
      a_param.m_global_id,
      a_param.m_displayName,
      a_param.m_default,
      a_param.m_description);
    return;
  } // if

  if(a_param.m_type == S_Param_Type_MultiLineStr)
  {
    a_build_param.declareParameterMultiLineStr(a_param.m_parentGroup.m_global_id,
      a_param.m_global_id,
      a_param.m_displayName,
      a_param.m_default,
      a_param.m_description);
    return;
  } // if

  if(a_param.m_type == S_Param_Type_Base64Str)
  {
    a_build_param.declareParameterBase64Str(a_param.m_parentGroup.m_global_id,
      a_param.m_global_id,
      a_param.m_displayName,
      a_param.m_default,
      a_param.m_description);
    return;
  } // if

  throw new Error('Unknown parameter type');
};

/**
* 'Declare' a parameter group recursively.
* Same steps as ClassAtuParamGroup.declare(): group, parameters,
* child groups. "Recursively" means the function calls itself for
* every child group, so trees of any depth are declared.
* @param  a_build_param  bsBuildParam object (argument of declareParameters)
* @param  a_group        Group object (ClassAtuParamGroup)
*/
function DeclareGroupRecursive(a_build_param, a_group)
{
  if(!a_group.isGrpVisible()) return;
  
  a_build_param.declareParameterGroup(a_group.m_global_id,
    a_group.m_displayName,
    a_group.m_description,
    a_group.m_flags);

  let l_child_param_count = a_group.m_childParamsArray.length;
  for(let i=0;i<l_child_param_count;++i)
  {
    DeclareParameter(a_build_param, a_group.m_childParamsArray[i]);
  } // for

  let l_child_grp_count = a_group.m_childGroupsArray.length;
  for(let i=0;i<l_child_grp_count;++i)
  {
    DeclareGroupRecursive(a_build_param, a_group.m_childGroupsArray[i]);
  } // for
};

// Make the 'AtuParamGroup' class available for users of this module
// Tip: Only what is assigned to 'exports' is visible to other
// modules that require() this file. ClassAtuParam and the helper
// functions above stay private to this module.
exports.AtuParamGroup = ClassAtuParamGroup;

